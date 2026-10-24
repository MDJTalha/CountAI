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
const secret = 'test-only-spais-learning-secret';
const issuer = 'https://identity.example.test/';
const audience = 'spais-api';

function token({
  sub = 'operator-1',
  organizationIds = ['org-1'],
  sitesByOrganization = { 'org-1': ['site-1'] },
  permissions = ['site:read', 'site:manage', 'model:read', 'model:propose', 'model:approve', 'audit:read']
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
  tempDir = await mkdtemp(join(tmpdir(), 'spais-learning-candidates-'));
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
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

function auth(overrides = {}) { return { authorization: 'Bearer ' + token(overrides) }; }
async function post(path, body, overrides = {}) {
  return fetch(baseUrl + path, { method: 'POST', headers: { ...auth(overrides), 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

test('learning candidates are scoped, auditable, independently reviewed for evaluation, and cannot be promoted to production', async () => {
  const unauthenticated = await fetch(baseUrl + '/api/v1/organizations/org-1/model-candidates?siteId=site-1');
  assert.equal(unauthenticated.status, 401);

  const site = await post('/api/v1/organizations/org-1/sites', { id: 'site-1', name: 'Learning test site' });
  assert.equal(site.status, 201);

  const candidateInput = {
    siteId: 'site-1',
    title: 'Evaluate improved people-counting threshold',
    rationale: 'Measure whether a revised threshold reduces false detections on a held-out, consented evaluation set.',
    baselineVersion: 'counting-model-1.0',
    proposedVersion: 'counting-model-1.1-candidate',
    changeType: 'thresholds',
    artifactSha256: 'a'.repeat(64),
    evaluationDatasetSha256: 'b'.repeat(64),
    evaluationPlan: [
      'Run the independent holdout evaluation without training-data overlap.',
      'Report precision, recall, false-positive rate and confidence intervals.',
      'Compare against the pinned baseline and pre-agreed acceptance thresholds.'
    ]
  };
  const createdResponse = await post('/api/v1/organizations/org-1/model-candidates', candidateInput);
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()).candidate;
  assert.equal(created.status, 'proposed');
  assert.equal(created.createdBy, 'operator-1');
  assert.equal(created.artifactSha256, 'a'.repeat(64));
  assert.equal(created.evaluationPlan.length, 3);

  const spoofed = await post('/api/v1/organizations/org-1/model-candidates', {
    ...candidateInput, status: 'active', createdBy: 'attacker'
  });
  assert.equal(spoofed.status, 400);

  const list = await fetch(baseUrl + '/api/v1/organizations/org-1/model-candidates?siteId=site-1', { headers: auth() });
  assert.equal(list.status, 200);
  assert.equal((await list.json()).count, 1);

  async function transition(status, note, overrides = {}) {
    return fetch(baseUrl + '/api/v1/organizations/org-1/model-candidates/' + created.id + '?siteId=site-1', {
      method: 'PATCH', headers: { ...auth(overrides), 'content-type': 'application/json' },
      body: JSON.stringify({ status, note })
    });
  }
  const review = await transition('under_review', 'Submitted the candidate metadata for governance review');
  assert.equal(review.status, 200);
  const selfApproval = await transition('evaluation_pending', 'Approve my own candidate for evaluation');
  assert.equal(selfApproval.status, 409);
  assert.equal((await selfApproval.json()).error, 'learning_candidate_self_approval_denied');

  const evaluationGate = await transition('evaluation_pending', 'Independent reviewer approved offline evaluation only', { sub: 'reviewer-2' });
  assert.equal(evaluationGate.status, 200);
  assert.equal((await evaluationGate.json()).candidate.status, 'evaluation_pending');

  const attemptedPromotion = await transition('active', 'Promote candidate to production', { sub: 'reviewer-2' });
  assert.equal(attemptedPromotion.status, 400);
  const stillPending = await fetch(baseUrl + '/api/v1/organizations/org-1/model-candidates/' + created.id + '?siteId=site-1', { headers: auth() });
  assert.equal((await stillPending.json()).candidate.status, 'evaluation_pending');

  const wrongSite = await fetch(baseUrl + '/api/v1/organizations/org-1/model-candidates?siteId=site-2', { headers: auth() });
  assert.equal(wrongSite.status, 403);
  const wrongTenant = await fetch(baseUrl + '/api/v1/organizations/org-2/model-candidates?siteId=site-1', { headers: auth() });
  assert.equal(wrongTenant.status, 403);
  const noPermission = await fetch(baseUrl + '/api/v1/organizations/org-1/model-candidates?siteId=site-1', {
    headers: auth({ permissions: ['site:read'] })
  });
  assert.equal(noPermission.status, 403);

  const audit = await fetch(baseUrl + '/api/v1/organizations/org-1/audit?siteId=site-1', { headers: auth() });
  assert.equal(audit.status, 200);
  const actions = (await audit.json()).events.filter(event => event.resourceType === 'model_candidate' && event.resourceId === created.id).map(event => event.action);
  assert.deepEqual(actions, ['model_candidate.status_changed', 'model_candidate.status_changed', 'model_candidate.created']);
});
