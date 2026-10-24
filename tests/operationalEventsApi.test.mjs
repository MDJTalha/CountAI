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
const secret = 'test-only-spais-secret';
const issuer = 'https://identity.example.test/';
const audience = 'spais-api';

function token({ sub = 'operator-1', organizationIds = ['org-1'], sitesByOrganization = { 'org-1': ['site-1'] }, permissions = ['session:read', 'session:manage'] } = {}) {
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
  tempDir = await mkdtemp(join(tmpdir(), 'spais-event-api-'));
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server/index.mjs'], {
    env: {
      ...process.env,
      PORT: String(port),
      SPAIS_EVENTS_FILE: join(tempDir, 'events.jsonl'),
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

test('operational events API enforces trusted identity, permissions and tenant/site isolation', async () => {
  const noAuth = await fetch(`${baseUrl}/api/v1/organizations/org-1/events`);
  assert.equal(noAuth.status, 401);

  const crossTenant = await fetch(`${baseUrl}/api/v1/organizations/org-2/events`, {
    headers: { authorization: `Bearer ${token()}` }
  });
  assert.equal(crossTenant.status, 403);

  const noPermission = await fetch(`${baseUrl}/api/v1/organizations/org-1/events`, {
    headers: { authorization: `Bearer ${token({ permissions: ['camera:read'] })}` }
  });
  assert.equal(noPermission.status, 403);

  const post = await fetch(`${baseUrl}/api/v1/organizations/org-1/events`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token()}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      eventType: 'line.crossed',
      sessionId: 'session-1',
      siteId: 'site-1',
      details: { direction: 'in', count: 1 },
      organizationId: 'org-attacker',
      actorId: 'attacker'
    })
  });
  assert.equal(post.status, 201);
  const created = (await post.json()).event;
  assert.equal(created.organizationId, 'org-1');
  assert.equal(created.actorId, 'operator-1');
  assert.equal(created.siteId, 'site-1');

  const siteDenied = await fetch(`${baseUrl}/api/v1/organizations/org-1/events?siteId=site-2`, {
    headers: { authorization: `Bearer ${token()}` }
  });
  assert.equal(siteDenied.status, 403);

  const listed = await fetch(`${baseUrl}/api/v1/organizations/org-1/events?siteId=site-1`, {
    headers: { authorization: `Bearer ${token()}` }
  });
  assert.equal(listed.status, 200);
  const body = await listed.json();
  assert.equal(body.count, 1);
  assert.equal(body.events[0].id, created.id);

  const invalid = await fetch(`${baseUrl}/api/v1/organizations/org-1/events`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token()}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ eventType: 'unknown', sessionId: '../escape' })
  });
  assert.equal(invalid.status, 400);
});
