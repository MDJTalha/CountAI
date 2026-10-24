import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
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
  permissions = ['site:read', 'site:manage', 'camera:read', 'camera:manage', 'connector:read', 'connector:manage']
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

  const camera = await post('/api/v1/organizations/org-1/cameras', {
    id: 'camera-1', siteId: 'site-1', name: 'Lobby Camera', metadata: { manufacturer: 'Example', protocol: 'onvif' }
  });
  assert.equal(camera.status, 201);
  assert.equal((await camera.json()).resource.status, 'pending');

  const listed = await fetch(`${baseUrl}/api/v1/organizations/org-1/cameras?siteId=site-1`, { headers: auth() });
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).resources.map(item => item.id), ['camera-1']);

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
