import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { canonicalizeConnectorTelemetry } from '../server/spais/connectorTelemetry.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

let child;
let baseUrl;
let tempDir;
let output = '';
const secret = 'test-only-spais-resource-secret';
const issuer = 'https://identity.example.test/';
const audience = 'spais-api';

function token({
  sub = 'operator-1',
  organizationIds = ['org-1'],
  sitesByOrganization = { 'org-1': ['site-1'] },
  permissions = ['site:read', 'site:manage', 'camera:read', 'camera:manage', 'connector:read', 'connector:manage', 'audit:read']
} = {}) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({
    iss: issuer, aud: audience, sub,
    exp: Math.floor(Date.now() / 1000) + 300,
    organizationIds, sitesByOrganization, permissions
  });
  const signature = createHmac('sha256', secret).update(header + '.' + payload).digest('base64url');
  return `${header}.${payload}.${signature}`;
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
  tempDir = await mkdtemp(join(tmpdir(), 'spais-resources-api-'));
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server/index.mjs'], {
    env: {
      ...process.env,
      PORT: String(port),
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
    if (child.exitCode !== null) throw new Error(`Server exited before readiness. Output:\n${output}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become ready: ${lastError}\n${output}`);
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

function auth(overrides = {}) {
  return { authorization: `Bearer ${token(overrides)}` };
}

async function post(path, body, overrides = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { ...auth(overrides), 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

test('tenant resource APIs report enabled configuration only when auth and SQLite are configured', async () => {
  const response = await fetch(`${baseUrl}/api/v1/spais/contracts`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.authenticationConfigured, true);
  assert.equal(body.tenantResourceApiEnabled, true);
});

test('site, camera and connector metadata require verified identity and enforce tenant/site scope', async () => {
  const unauthenticated = await fetch(`${baseUrl}/api/v1/organizations/org-1/sites`);
  assert.equal(unauthenticated.status, 401);

  const site = await post('/api/v1/organizations/org-1/sites', {
    id: 'site-1', name: 'Head Office', status: 'active', metadata: { timezone: 'Asia/Karachi' }
  });
  assert.equal(site.status, 201);
  const siteBody = (await site.json()).resource;
  assert.equal(siteBody.organizationId, 'org-1');
  assert.equal(siteBody.createdBy, 'operator-1');
  assert.equal(siteBody.resourceType, 'site');

  const secondSite = await post('/api/v1/organizations/org-1/sites', {
    id: 'site-2', name: 'Restricted Branch'
  }, { sitesByOrganization: { 'org-1': ['site-1', 'site-2'] } });
  assert.equal(secondSite.status, 201);

  const scopedSites = await fetch(`${baseUrl}/api/v1/organizations/org-1/sites`, { headers: auth() });
  assert.equal(scopedSites.status, 200);
  assert.deepEqual((await scopedSites.json()).resources.map(item => item.id), ['site-1']);

  const allowedSite = await fetch(`${baseUrl}/api/v1/organizations/org-1/sites/site-1`, { headers: auth() });
  assert.equal(allowedSite.status, 200);
  const forbiddenSite = await fetch(`${baseUrl}/api/v1/organizations/org-1/sites/site-2`, { headers: auth() });
  assert.equal(forbiddenSite.status, 403);

  const camera = await post('/api/v1/organizations/org-1/cameras', {
    id: 'camera-1', siteId: 'site-1', name: 'Lobby Camera', metadata: { manufacturer: 'Example', protocol: 'onvif' }
  });
  assert.equal(camera.status, 201);
  assert.equal((await camera.json()).resource.status, 'pending');

  const listed = await fetch(`${baseUrl}/api/v1/organizations/org-1/cameras?siteId=site-1`, { headers: auth() });
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).resources.map(item => item.id), ['camera-1']);

  const updated = await fetch(`${baseUrl}/api/v1/organizations/org-1/cameras/camera-1?siteId=site-1`, {
    method: 'PATCH',
    headers: { ...auth(), 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Lobby Camera Updated' })
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).resource.name, 'Lobby Camera Updated');

  const unscopedAudit = await fetch(`${baseUrl}/api/v1/organizations/org-1/audit`, { headers: auth() });
  assert.equal(unscopedAudit.status, 400);
  assert.equal((await unscopedAudit.json()).error, 'site_id_required');

  const audit = await fetch(`${baseUrl}/api/v1/organizations/org-1/audit?siteId=site-1`, { headers: auth() });
  assert.equal(audit.status, 200);
  const auditBody = await audit.json();
  assert.ok(auditBody.events.some(item => item.action === 'resource.created' && item.resourceId === 'camera-1'));
  assert.ok(auditBody.events.some(item => item.action === 'resource.updated' && item.resourceId === 'camera-1'));

  const noAuditPermission = await fetch(`${baseUrl}/api/v1/organizations/org-1/audit?siteId=site-1`, {
    headers: auth({ permissions: ['site:read'] })
  });
  assert.equal(noAuditPermission.status, 403);

  const missingSiteFilter = await fetch(`${baseUrl}/api/v1/organizations/org-1/cameras`, { headers: auth() });
  assert.equal(missingSiteFilter.status, 400);

  const crossTenant = await fetch(`${baseUrl}/api/v1/organizations/org-2/sites`, { headers: auth() });
  assert.equal(crossTenant.status, 403);

  const crossSite = await post('/api/v1/organizations/org-1/cameras', {
    id: 'camera-2', siteId: 'site-2', name: 'Restricted Camera'
  });
  assert.equal(crossSite.status, 403);
});

test('resource API rejects spoofed fields, credentials, duplicate IDs and orphan cameras', async () => {
  const spoofed = await post('/api/v1/organizations/org-1/sites', {
    id: 'site-spoof', name: 'Spoof', organizationId: 'org-attacker', createdBy: 'attacker'
  });
  assert.equal(spoofed.status, 400);

  const credential = await post('/api/v1/organizations/org-1/connectors', {
    id: 'connector-1', siteId: 'site-1', name: 'Edge Connector',
    metadata: { accessToken: 'should-not-be-stored' }
  });
  assert.equal(credential.status, 400);

  const falseCameraStatus = await post('/api/v1/organizations/org-1/cameras', {
    id: 'camera-active', siteId: 'site-1', name: 'Unverified Camera', status: 'active'
  });
  assert.equal(falseCameraStatus.status, 400);

  const falseConnectorStatus = await post('/api/v1/organizations/org-1/connectors', {
    id: 'connector-active', siteId: 'site-1', name: 'Unenrolled Connector', status: 'active'
  });
  assert.equal(falseConnectorStatus.status, 400);

  const orphan = await post('/api/v1/organizations/org-1/cameras', {
    id: 'camera-orphan', siteId: 'site-missing', name: 'Orphan Camera'
  });
  assert.equal(orphan.status, 403);

  const first = await post('/api/v1/organizations/org-1/sites', { id: 'site-duplicate', name: 'Branch' });
  assert.equal(first.status, 201);
  const duplicate = await post('/api/v1/organizations/org-1/sites', { id: 'site-duplicate', name: 'Branch Again' });
  assert.equal(duplicate.status, 409);
});

test('site and connector actions are checked independently', async () => {
  const noPermission = await post('/api/v1/organizations/org-1/sites', { id: 'site-denied', name: 'Denied' }, {
    permissions: ['site:read']
  });
  assert.equal(noPermission.status, 403);
});


test('connector enrollment requires one-time RSA proof-of-possession and creates an audit record', async () => {
  const connector = await post('/api/v1/organizations/org-1/connectors', {
    id: 'connector-enroll-1', siteId: 'site-1', name: 'Customer Edge Connector'
  });
  assert.equal(connector.status, 201);
  assert.equal((await connector.json()).resource.status, 'pending');

  // Invalid public keys must be rejected without creating an enrollment.
  const invalidKeyResponse = await fetch(
    `${baseUrl}/api/v1/organizations/org-1/connectors/connector-enroll-1/enrollment-challenges?siteId=site-1`,
    {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ publicKeyJwk: { kty: 'RSA' } })
    }
  );
  assert.equal(invalidKeyResponse.status, 400);

  // The connector generates its key pair locally. The operator binds its public key before receiving a challenge.
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicKeyJwk = publicKey.export({ format: 'jwk' });
  const challengeResponse = await fetch(
    `${baseUrl}/api/v1/organizations/org-1/connectors/connector-enroll-1/enrollment-challenges?siteId=site-1`,
    {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ publicKeyJwk })
    }
  );
  assert.equal(challengeResponse.status, 201);
  const challenge = (await challengeResponse.json()).enrollment;
  assert.ok(challenge.challenge);
  assert.ok(challenge.expiresAt);
  assert.ok(challenge.keyThumbprint);

  const proof = value => sign('RSA-SHA256', Buffer.from(challenge.enrollmentId + '.' + challenge.challenge), value).toString('base64url');
  const completionUrl = `${baseUrl}/api/v1/connector-enrollments/${challenge.enrollmentId}/complete`;
  const invalidProof = await fetch(completionUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challenge: challenge.challenge, signature: 'invalid-signature' })
  });
  assert.equal(invalidProof.status, 401);

  const completion = await fetch(completionUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challenge: challenge.challenge, signature: proof(privateKey) })
  });
  assert.equal(completion.status, 200);
  const result = (await completion.json()).enrollment;
  assert.equal(result.connector.status, 'enrolled');
  assert.equal(result.keyThumbprint, challenge.keyThumbprint);

  const connectorRead = await fetch(
    `${baseUrl}/api/v1/organizations/org-1/connectors/connector-enroll-1?siteId=site-1`,
    { headers: auth() }
  );
  assert.equal(connectorRead.status, 200);
  assert.equal((await connectorRead.json()).resource.status, 'enrolled');

  // Rotation is allowed while the connector is enrolled; successful rotation revokes the prior key.
  const rotatedKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rotationChallengeResponse = await fetch(
    `${baseUrl}/api/v1/organizations/org-1/connectors/connector-enroll-1/enrollment-challenges?siteId=site-1`,
    {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ publicKeyJwk: rotatedKeys.publicKey.export({ format: 'jwk' }) })
    }
  );
  assert.equal(rotationChallengeResponse.status, 201);
  const rotationChallenge = (await rotationChallengeResponse.json()).enrollment;
  const rotationProof = sign(
    'RSA-SHA256',
    Buffer.from(rotationChallenge.enrollmentId + '.' + rotationChallenge.challenge),
    rotatedKeys.privateKey
  ).toString('base64url');
  const rotationCompletion = await fetch(
    `${baseUrl}/api/v1/connector-enrollments/${rotationChallenge.enrollmentId}/complete`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challenge: rotationChallenge.challenge, signature: rotationProof })
    }
  );
  assert.equal(rotationCompletion.status, 200);
  assert.notEqual((await rotationCompletion.json()).enrollment.keyThumbprint, result.keyThumbprint);

  const telemetry = keyPair => {
    const message = {
      organizationId: 'org-1', siteId: 'site-1', connectorId: 'connector-enroll-1',
      timestamp: new Date().toISOString(), nonce: randomBytes(24).toString('base64url'),
      eventType: 'connector.heartbeat', payload: { status: 'healthy' }
    };
    message.signature = sign('RSA-SHA256', canonicalizeConnectorTelemetry(message), keyPair).toString('base64url');
    return message;
  };
  const telemetryUrl = `${baseUrl}/api/v1/connectors/connector-enroll-1/telemetry`;
  const oldKeyTelemetry = await fetch(telemetryUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(telemetry(privateKey))
  });
  assert.equal(oldKeyTelemetry.status, 401);
  const newKeyTelemetry = await fetch(telemetryUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(telemetry(rotatedKeys.privateKey))
  });
  assert.equal(newKeyTelemetry.status, 202);

  const revoked = await fetch(
    `${baseUrl}/api/v1/organizations/org-1/connectors/connector-enroll-1?siteId=site-1`,
    { method: 'PATCH', headers: { ...auth(), 'content-type': 'application/json' }, body: JSON.stringify({ status: 'revoked' }) }
  );
  assert.equal(revoked.status, 200);
  const revokedTelemetry = await fetch(telemetryUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(telemetry(rotatedKeys.privateKey))
  });
  assert.equal(revokedTelemetry.status, 401);
  assert.equal((await revokedTelemetry.json()).error, 'connector_identity_not_active');

  const replay = await fetch(completionUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challenge: challenge.challenge, signature: proof(privateKey) })
  });
  assert.equal(replay.status, 409);

  const audit = await fetch(`${baseUrl}/api/v1/organizations/org-1/audit?siteId=site-1`, { headers: auth() });
  assert.equal(audit.status, 200);
  const events = (await audit.json()).events;
  assert.ok(events.some(item => item.action === 'connector.enrollment_challenge_created'));
  assert.ok(events.some(item => item.action === 'connector.enrollment_completed'));
  assert.ok(events.some(item => item.action === 'connector.key_rotated'));
  assert.ok(events.some(item => item.action === 'connector.key_revoked'));
});
