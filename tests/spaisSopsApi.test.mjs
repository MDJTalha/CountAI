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
const secret = 'test-only-spais-sop-secret';
const issuer = 'https://identity.example.test/';
const audience = 'spais-api';

function token({
  sub = 'operator-1',
  organizationIds = ['org-1'],
  sitesByOrganization = { 'org-1': ['site-1'] },
  permissions = ['site:read', 'site:manage', 'sop:read', 'sop:manage', 'sop:approve', 'audit:read']
} = {}) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({
    iss: issuer, aud: audience, sub,
    exp: Math.floor(Date.now() / 1000) + 300,
    organizationIds, sitesByOrganization, permissions
  });
  const signature = createHmac('sha256', secret).update(header + '.' + payload).digest('base64url');
  return header + '.' + payload + '.' + signature;
}

async function reservePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}

before(async () => {
  const port = await reservePort();
  tempDir = await mkdtemp(join(tmpdir(), 'spais-sops-api-'));
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
    try { const response = await fetch(baseUrl + '/api/health'); if (response.ok) return; }
    catch (error) { lastError = error; }
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

function auth(overrides = {}) { return { authorization: 'Bearer ' + token(overrides) }; }
async function post(path, body, overrides = {}) {
  return fetch(baseUrl + path, {
    method: 'POST',
    headers: { ...auth(overrides), 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}
async function transition(sopId, status, note, overrides = {}) {
  return fetch(baseUrl + '/api/v1/organizations/org-1/sops/' + sopId + '?siteId=site-1', {
    method: 'PATCH',
    headers: { ...auth(overrides), 'content-type': 'application/json' },
    body: JSON.stringify({ status, note })
  });
}

test('SOP versions are tenant/site scoped, audited, versioned, and require independent approval', async () => {
  const unauthenticated = await fetch(baseUrl + '/api/v1/organizations/org-1/sops?siteId=site-1');
  assert.equal(unauthenticated.status, 401);

  const site = await post('/api/v1/organizations/org-1/sites', { id: 'site-1', name: 'Test site' });
  assert.equal(site.status, 201);

  const spoofed = await post('/api/v1/organizations/org-1/sops', {
    siteId: 'site-1', policyId: 'sop-fire', title: 'Fire response', content: 'Follow the approved procedure.',
    organizationId: 'org-evil', status: 'approved', createdBy: 'attacker'
  });
  assert.equal(spoofed.status, 400);

  const createdResponse = await post('/api/v1/organizations/org-1/sops', {
    siteId: 'site-1', policyId: 'sop-fire', title: 'Fire response',
    content: 'Raise the alarm and follow the site evacuation procedure.', category: 'safety'
  });
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()).sop;
  assert.equal(created.status, 'draft');
  assert.equal(created.version, 1);
  assert.equal(created.createdBy, 'operator-1');
  assert.equal(created.approvedBy, null);

  const selfApproval = await transition(created.id, 'in_review', 'Ready for independent review');
  assert.equal(selfApproval.status, 200);
  const forbiddenSelfApproval = await transition(created.id, 'approved', 'Approve own policy');
  assert.equal(forbiddenSelfApproval.status, 409);
  assert.equal((await (await fetch(baseUrl + '/api/v1/organizations/org-1/sops/' + created.id + '?siteId=site-1', { headers: auth() })).json()).sop.status, 'in_review');

  const noApprovalPermission = await transition(created.id, 'approved', 'Reviewed independently', {
    sub: 'reviewer-2', permissions: ['site:read', 'sop:read', 'sop:manage', 'audit:read']
  });
  assert.equal(noApprovalPermission.status, 403);

  const approved = await transition(created.id, 'approved', 'Independent reviewer approved the reviewed procedure', { sub: 'reviewer-2' });
  assert.equal(approved.status, 200);
  const approvedSop = (await approved.json()).sop;
  assert.equal(approvedSop.status, 'approved');
  assert.equal(approvedSop.approvedBy, 'reviewer-2');
  assert.ok(approvedSop.approvedAt);

  const invalidEdit = await fetch(baseUrl + '/api/v1/organizations/org-1/sops/' + created.id + '?siteId=site-1', {
    method: 'PATCH',
    headers: { ...auth(), 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'draft', note: 'Try to mutate an approved version' })
  });
  assert.equal(invalidEdit.status, 409);

  const secondVersion = await post('/api/v1/organizations/org-1/sops', {
    siteId: 'site-1', policyId: 'sop-fire', title: 'Fire response revised',
    content: 'Use the updated evacuation map and follow the site procedure.', category: 'safety'
  });
  assert.equal(secondVersion.status, 201);
  const versionTwo = (await secondVersion.json()).sop;
  assert.equal(versionTwo.version, 2);
  assert.equal(versionTwo.status, 'draft');
  assert.notEqual(versionTwo.id, created.id);

  const list = await fetch(baseUrl + '/api/v1/organizations/org-1/sops?siteId=site-1', { headers: auth() });
  assert.equal(list.status, 200);
  assert.equal((await list.json()).count, 2);

  const audit = await fetch(baseUrl + '/api/v1/organizations/org-1/audit?siteId=site-1', { headers: auth() });
  assert.equal(audit.status, 200);
  const actions = (await audit.json()).events.filter(event => event.resourceType === 'sop_version' && event.resourceId === created.id).map(event => event.action);
  assert.deepEqual(actions, ['sop.version_approved', 'sop.status_changed', 'sop.version_created']);

  const wrongSite = await fetch(baseUrl + '/api/v1/organizations/org-1/sops?siteId=site-2', { headers: auth() });
  assert.equal(wrongSite.status, 403);
  const wrongTenant = await fetch(baseUrl + '/api/v1/organizations/org-2/sops?siteId=site-1', { headers: auth() });
  assert.equal(wrongTenant.status, 403);
  const noReadPermission = await fetch(baseUrl + '/api/v1/organizations/org-1/sops?siteId=site-1', {
    headers: auth({ permissions: ['site:read'] })
  });
  assert.equal(noReadPermission.status, 403);
});
