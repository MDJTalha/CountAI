import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { canonicalizeConnectorTelemetry } from '../server/spais/connectorTelemetry.mjs';

let child;
let baseUrl;
let tempDir;
let output = '';
const secret = 'test-only-spais-telemetry-secret';
const issuer = 'https://identity.example.test/';
const audience = 'spais-api';

function token() {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({
    iss: issuer, aud: audience, sub: 'operator-1',
    exp: Math.floor(Date.now() / 1000) + 300,
    organizationIds: ['org-1'], sitesByOrganization: { 'org-1': ['site-1'] },
    permissions: ['site:manage', 'camera:manage', 'connector:manage', 'connector:read', 'audit:read']
  });
  const signature = createHmac('sha256', secret).update(header + '.' + payload).digest('base64url');
  return header + '.' + payload + '.' + signature;
}

async function reservePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}

before(async () => {
  const port = await reservePort();
  tempDir = await mkdtemp(join(tmpdir(), 'spais-connector-telemetry-'));
  baseUrl = 'http://127.0.0.1:' + port;
  child = spawn(process.execPath, ['server/index.mjs'], {
    env: {
      ...process.env, PORT: String(port),
      SPAIS_EVENTS_DB_PATH: join(tempDir, 'spais.sqlite'),
      SPAIS_AUTH_HS256_SECRET: secret,
      SPAIS_AUTH_ISSUER: issuer,
      SPAIS_AUTH_AUDIENCE: audience
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const deadline = Date.now() + 8000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Server exited before readiness. Output:\n' + output);
    try {
      const response = await fetch(baseUrl + '/api/health');
      if (response.ok) return;
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Server did not become ready: ' + lastError + '\n' + output);
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 2000))
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

const authHeaders = () => ({
  authorization: 'Bearer ' + token(),
  'content-type': 'application/json'
});
async function post(path, body, headers = authHeaders()) {
  return fetch(baseUrl + path, { method: 'POST', headers, body: JSON.stringify(body) });
}

test('enrolled connector telemetry verifies signatures, enforces freshness and rejects nonce replay', async () => {
  const site = await post('/api/v1/organizations/org-1/sites', { id: 'site-1', name: 'Test Site' });
  assert.equal(site.status, 201);
  const camera = await post('/api/v1/organizations/org-1/cameras', {
    id: 'camera-1', siteId: 'site-1', name: 'Lobby Camera'
  });
  assert.equal(camera.status, 201);
  const connector = await post('/api/v1/organizations/org-1/connectors', {
    id: 'connector-1', siteId: 'site-1', name: 'Customer Edge Connector'
  });
  assert.equal(connector.status, 201);

  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const challengeResponse = await post(
    '/api/v1/organizations/org-1/connectors/connector-1/enrollment-challenges?siteId=site-1',
    { publicKeyJwk: publicKey.export({ format: 'jwk' }) }
  );
  assert.equal(challengeResponse.status, 201);
  const challenge = (await challengeResponse.json()).enrollment;
  const enrollmentProof = sign(
    'RSA-SHA256', Buffer.from(challenge.enrollmentId + '.' + challenge.challenge), privateKey
  ).toString('base64url');
  const completed = await post('/api/v1/connector-enrollments/' + challenge.enrollmentId + '/complete', {
    challenge: challenge.challenge, signature: enrollmentProof
  }, { 'content-type': 'application/json' });
  assert.equal(completed.status, 200);

  const makeMessage = (eventType, payload, overrides = {}) => {
    const message = {
      organizationId: 'org-1', siteId: 'site-1', connectorId: 'connector-1',
      timestamp: new Date().toISOString(),
      nonce: randomBytes(24).toString('base64url'),
      eventType, payload, ...overrides
    };
    message.signature = sign('RSA-SHA256', canonicalizeConnectorTelemetry(message), privateKey).toString('base64url');
    return message;
  };
  const telemetryPath = '/api/v1/connectors/connector-1/telemetry';

  const heartbeat = makeMessage('connector.heartbeat', {
    status: 'healthy', uptimeSeconds: 3600, version: '1.0.0'
  });
  const accepted = await post(telemetryPath, heartbeat, { 'content-type': 'application/json' });
  assert.equal(accepted.status, 202);
  const receipt = (await accepted.json()).receipt;
  assert.equal(receipt.trustLevel, 'connector-signed-report');
  assert.equal(receipt.eventType, 'connector.heartbeat');

  const replay = await post(telemetryPath, heartbeat, { 'content-type': 'application/json' });
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).error, 'telemetry_replay_detected');

  const forged = makeMessage('connector.heartbeat', { status: 'healthy' });
  forged.payload.status = 'degraded';
  const forgedResponse = await post(telemetryPath, forged, { 'content-type': 'application/json' });
  assert.equal(forgedResponse.status, 401);

  const stale = makeMessage('connector.heartbeat', { status: 'healthy' }, {
    timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString()
  });
  stale.signature = sign('RSA-SHA256', canonicalizeConnectorTelemetry(stale), privateKey).toString('base64url');
  const staleResponse = await post(telemetryPath, stale, { 'content-type': 'application/json' });
  assert.equal(staleResponse.status, 401);
  assert.equal((await staleResponse.json()).error, 'telemetry_timestamp_out_of_window');

  const cameraHealth = makeMessage('camera.health', {
    cameraId: 'camera-1', status: 'online', observedAt: new Date().toISOString()
  });
  const cameraResponse = await post(telemetryPath, cameraHealth, { 'content-type': 'application/json' });
  assert.equal(cameraResponse.status, 202);

  const crossSiteCamera = makeMessage('camera.health', {
    cameraId: 'camera-from-another-site', status: 'online'
  });
  const crossSiteResponse = await post(telemetryPath, crossSiteCamera, { 'content-type': 'application/json' });
  assert.equal(crossSiteResponse.status, 403);
  assert.equal((await crossSiteResponse.json()).error, 'telemetry_camera_scope_mismatch');

  const coverage = makeMessage('recorder.recording_coverage', {
    cameraId: 'camera-1',
    windowStart: '2026-10-24T00:00:00.000Z',
    windowEnd: '2026-10-24T01:00:00.000Z',
    recordedSeconds: 3500,
    expectedSeconds: 3600,
    evidenceDigest: 'a'.repeat(64)
  });
  const coverageResponse = await post(telemetryPath, coverage, { 'content-type': 'application/json' });
  assert.equal(coverageResponse.status, 202);
  const coverageReceipt = (await coverageResponse.json()).receipt;
  assert.equal(coverageReceipt.interpretation, 'reported_not_independently_verified');

  const unsafe = makeMessage('connector.heartbeat', { status: 'healthy', frameData: 'should-not-be-accepted' });
  const unsafeResponse = await post(telemetryPath, unsafe, { 'content-type': 'application/json' });
  assert.equal(unsafeResponse.status, 400);

  const wrongConnector = await post('/api/v1/connectors/connector-2/telemetry', heartbeat, {
    'content-type': 'application/json'
  });
  assert.equal(wrongConnector.status, 400);
});
