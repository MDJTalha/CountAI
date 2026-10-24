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
const secret = 'test-only-spais-incident-secret';
const issuer = 'https://identity.example.test/';
const audience = 'spais-api';

function token({ sub = 'operator-1', organizationIds = ['org-1'], sitesByOrganization = { 'org-1': ['site-1'] }, permissions = ['site:read', 'site:manage', 'incident:read', 'incident:manage', 'sop:read', 'sop:manage', 'sop:approve', 'audit:read'] } = {}) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({ iss: issuer, aud: audience, sub, exp: Math.floor(Date.now() / 1000) + 300, organizationIds, sitesByOrganization, permissions });
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
  tempDir = await mkdtemp(join(tmpdir(), 'spais-incidents-api-'));
  baseUrl = 'http://127.0.0.1:' + port;
  child = spawn(process.execPath, ['server/index.mjs'], {
    env: { ...process.env, PORT: String(port), SPAIS_EVENTS_DB_PATH: join(tempDir, 'spais.sqlite'), SPAIS_AUTH_HS256_SECRET: secret, SPAIS_AUTH_ISSUER: issuer, SPAIS_AUTH_AUDIENCE: audience },
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
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

function auth(overrides = {}) { return { authorization: 'Bearer ' + token(overrides) }; }
async function post(path, body, overrides = {}) {
  return fetch(baseUrl + path, { method: 'POST', headers: { ...auth(overrides), 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

test('incident lifecycle is tenant/site scoped, auditable, links only approved same-site SOP versions, and does not promote reported recorder claims to verified evidence', async () => {
  const unauthenticated = await fetch(baseUrl + '/api/v1/organizations/org-1/incidents?siteId=site-1');
  assert.equal(unauthenticated.status, 401);

  const site = await post('/api/v1/organizations/org-1/sites', { id: 'site-1', name: 'Test site' });
  assert.equal(site.status, 201);

  const sopResponse = await post('/api/v1/organizations/org-1/sops', {
    siteId: 'site-1', policyId: 'sop-fire', title: 'Fire response',
    content: 'Raise the alarm and follow the approved evacuation procedure.', category: 'safety'
  });
  assert.equal(sopResponse.status, 201);
  const sopDraft = (await sopResponse.json()).sop;
  const submitSop = await fetch(baseUrl + '/api/v1/organizations/org-1/sops/' + sopDraft.id + '?siteId=site-1', {
    method: 'PATCH', headers: { ...auth(), 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'in_review', note: 'Ready for independent safety review' })
  });
  assert.equal(submitSop.status, 200);
  const approveSop = await fetch(baseUrl + '/api/v1/organizations/org-1/sops/' + sopDraft.id + '?siteId=site-1', {
    method: 'PATCH', headers: { ...auth({ sub: 'reviewer-2' }), 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'approved', note: 'Independent reviewer approved the fire response SOP' })
  });
  assert.equal(approveSop.status, 200);
  const approvedSop = (await approveSop.json()).sop;
  assert.equal(approvedSop.status, 'approved');

  const draftOnlyResponse = await post('/api/v1/organizations/org-1/sops', {
    siteId: 'site-1', policyId: 'sop-draft-only', title: 'Draft-only procedure',
    content: 'This procedure has not been approved.', category: 'operations'
  });
  assert.equal(draftOnlyResponse.status, 201);
  const draftOnlySop = (await draftOnlyResponse.json()).sop;

  const spoofed = await post('/api/v1/organizations/org-1/incidents', {
    siteId: 'site-1', title: 'Spoofed', organizationId: 'org-evil', evidenceState: 'independently_verified'
  });
  assert.equal(spoofed.status, 400);

  const createdResponse = await post('/api/v1/organizations/org-1/incidents', {
    siteId: 'site-1', title: 'Recorder coverage report received', description: 'Operator review required',
    severity: 'high', source: 'recording_coverage', sopVersionId: approvedSop.id
  });
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()).incident;
  assert.equal(created.status, 'open');
  assert.equal(created.severity, 'high');
  assert.equal(created.evidenceState, 'reported_not_independently_verified');
  assert.equal(created.createdBy, 'operator-1');
  assert.equal(created.sopVersionId, approvedSop.id);

  const draftLink = await post('/api/v1/organizations/org-1/incidents', {
    siteId: 'site-1', title: 'Cannot link draft SOP', sopVersionId: draftOnlySop.id
  });
  assert.equal(draftLink.status, 409);
  assert.equal((await draftLink.json()).error, 'linked_sop_not_approved_or_not_found');

  const invalidSopId = await post('/api/v1/organizations/org-1/incidents', {
    siteId: 'site-1', title: 'Invalid SOP reference', sopVersionId: 'bad id with spaces'
  });
  assert.equal(invalidSopId.status, 400);

  const list = await fetch(baseUrl + '/api/v1/organizations/org-1/incidents?siteId=site-1', { headers: auth() });
  assert.equal(list.status, 200);
  assert.equal((await list.json()).count, 1);

  const invalidTransition = await fetch(baseUrl + '/api/v1/organizations/org-1/incidents/' + created.id + '?siteId=site-1', {
    method: 'PATCH', headers: { ...auth(), 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'resolved', note: 'Try to skip investigation' })
  });
  assert.equal(invalidTransition.status, 409);

  async function transition(status, note = 'Operator reviewed state and recorded this transition') {
    return fetch(baseUrl + '/api/v1/organizations/org-1/incidents/' + created.id + '?siteId=site-1', {
      method: 'PATCH', headers: { ...auth(), 'content-type': 'application/json' }, body: JSON.stringify({ status, note })
    });
  }
  assert.equal((await transition('acknowledged')).status, 200);
  assert.equal((await transition('investigating')).status, 200);
  const resolved = await transition('resolved', 'Reviewed evidence and documented the resolution');
  assert.equal(resolved.status, 200);
  assert.ok((await resolved.json()).incident.resolvedAt);
  const reopened = await transition('open', 'Reopened because follow-up evidence is required');
  assert.equal(reopened.status, 200);
  assert.equal((await reopened.json()).incident.status, 'open');

  const wrongSite = await fetch(baseUrl + '/api/v1/organizations/org-1/incidents?siteId=site-2', { headers: auth() });
  assert.equal(wrongSite.status, 403);
  const wrongTenant = await fetch(baseUrl + '/api/v1/organizations/org-2/incidents?siteId=site-1', { headers: auth() });
  assert.equal(wrongTenant.status, 403);
  const noPermission = await fetch(baseUrl + '/api/v1/organizations/org-1/incidents?siteId=site-1', {
    headers: auth({ permissions: ['site:read'] })
  });
  assert.equal(noPermission.status, 403);

  const audit = await fetch(baseUrl + '/api/v1/organizations/org-1/audit?siteId=site-1', { headers: auth() });
  assert.equal(audit.status, 200);
  const actions = (await audit.json()).events.filter(event => event.resourceType === 'incident' && event.resourceId === created.id).map(event => event.action);
  assert.deepEqual(actions, ['incident.reopened', 'incident.resolved', 'incident.investigating', 'incident.acknowledged', 'incident.created']);
});
