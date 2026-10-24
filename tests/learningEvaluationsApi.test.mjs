import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { canonicalizeLearningEvaluationReport } from '../server/spais/learningEvaluations.mjs';

let child, baseUrl, tempDir, output = '';
const secret = 'test-only-spais-learning-evaluator-secret';
const issuer = 'https://identity.example.test/';
const audience = 'spais-api';
const evaluatorPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const evaluatorJwk = evaluatorPair.publicKey.export({ format: 'jwk' });

function token({ sub = 'operator-1', organizationIds = ['org-1'], sitesByOrganization = { 'org-1': ['site-1'] },
  permissions = ['site:read', 'site:manage', 'model:read', 'model:propose', 'model:approve', 'model:evaluate', 'audit:read'] } = {}) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({ iss: issuer, aud: audience, sub, exp: Math.floor(Date.now() / 1000) + 300, organizationIds, sitesByOrganization, permissions });
  return header + '.' + payload + '.' + createHmac('sha256', secret).update(header + '.' + payload).digest('base64url');
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
  tempDir = await mkdtemp(join(tmpdir(), 'spais-learning-evaluations-'));
  baseUrl = 'http://127.0.0.1:' + port;
  child = spawn(process.execPath, ['server/index.mjs'], { env: {
    ...process.env, PORT: String(port), SPAIS_EVENTS_DB_PATH: join(tempDir, 'spais.sqlite'),
    SPAIS_AUTH_HS256_SECRET: secret, SPAIS_AUTH_ISSUER: issuer, SPAIS_AUTH_AUDIENCE: audience,
    SPAIS_EVALUATOR_PUBLIC_KEY_JWK: JSON.stringify(evaluatorJwk), SPAIS_EVALUATOR_KEY_ID: 'test-evaluator-key-v1',
    SPAIS_EVALUATION_MIN_SAMPLE_COUNT: '100', SPAIS_EVALUATION_MIN_PRECISION: '0.9',
    SPAIS_EVALUATION_MIN_RECALL: '0.9', SPAIS_EVALUATION_MAX_FALSE_POSITIVE_RATE: '0.05'
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Server exited before readiness. Output:\n' + output);
    try { if ((await fetch(baseUrl + '/api/health')).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Server did not become ready. Output:\n' + output);
});
after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});
const auth = (overrides = {}) => ({ authorization: 'Bearer ' + token(overrides) });
const jsonHeaders = (overrides = {}) => ({ ...auth(overrides), 'content-type': 'application/json' });
async function post(path, body, overrides = {}) {
  return fetch(baseUrl + path, { method: 'POST', headers: jsonHeaders(overrides), body: JSON.stringify(body) });
}

test('signed evaluator reports are scoped, thresholded, replay-protected, and audit logged', async () => {
  assert.equal((await post('/api/v1/organizations/org-1/sites', { id: 'site-1', name: 'Evaluation test site' })).status, 201);
  const candidateInput = {
    siteId: 'site-1', title: 'Evaluate threshold revision',
    rationale: 'Measure false positives and recall on a held-out dataset before any later governance decision.',
    baselineVersion: 'baseline-1', proposedVersion: 'candidate-2', changeType: 'thresholds',
    artifactSha256: 'a'.repeat(64), evaluationDatasetSha256: 'b'.repeat(64),
    evaluationPlan: ['Run independent holdout evaluation.', 'Compare precision, recall and false-positive rate to configured thresholds.']
  };
  const candidateResponse = await post('/api/v1/organizations/org-1/model-candidates', candidateInput);
  assert.equal(candidateResponse.status, 201);
  const candidate = (await candidateResponse.json()).candidate;
  const transition = (status, subject) => fetch(
    baseUrl + '/api/v1/organizations/org-1/model-candidates/' + candidate.id + '?siteId=site-1',
    { method: 'PATCH', headers: jsonHeaders({ sub: subject }), body: JSON.stringify({ status, note: 'Governance transition for independent evaluation' }) }
  );
  assert.equal((await transition('under_review', 'operator-1')).status, 200);
  assert.equal((await transition('evaluation_pending', 'reviewer-2')).status, 200);

  const report = {
    runId: 'evaluation-run-1', artifactSha256: 'a'.repeat(64), evaluationDatasetSha256: 'b'.repeat(64),
    evaluatorVersion: 'independent-evaluator-1.0', evaluatedAt: new Date().toISOString(),
    nonce: randomBytes(32).toString('base64url'), sampleCount: 1000,
    precision: 0.96, recall: 0.93, falsePositiveRate: 0.02
  };
  report.signature = sign('RSA-SHA256', canonicalizeLearningEvaluationReport({
    organizationId: 'org-1', siteId: 'site-1', candidateId: candidate.id, report
  }), evaluatorPair.privateKey).toString('base64url');
  const path = '/api/v1/organizations/org-1/model-candidates/' + candidate.id + '/evaluations?siteId=site-1';
  const unauthenticated = await fetch(baseUrl + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report) });
  assert.equal(unauthenticated.status, 401);
  const accepted = await post(path, report);
  assert.equal(accepted.status, 201);
  const evaluation = (await accepted.json()).evaluation;
  assert.equal(evaluation.result, 'passed');
  assert.equal(evaluation.evaluatorKeyId, 'test-evaluator-key-v1');
  assert.equal(evaluation.attestationSha256.length, 64);

  const candidateAfter = await fetch(baseUrl + '/api/v1/organizations/org-1/model-candidates/' + candidate.id + '?siteId=site-1', { headers: auth() });
  const candidateBody = (await candidateAfter.json()).candidate;
  assert.equal(candidateBody.status, 'evaluation_pending');
  assert.equal(candidateBody.evaluationStatus, 'passed');

  const history = await fetch(baseUrl + path, { headers: auth() });
  assert.equal(history.status, 200);
  assert.equal((await history.json()).count, 1);
  const replay = await post(path, report);
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).error, 'learning_evaluation_replay_detected');

  const badSignature = { ...report, runId: 'evaluation-run-2', nonce: randomBytes(32).toString('base64url') };
  const badSignatureResponse = await post(path, badSignature);
  assert.equal(badSignatureResponse.status, 401);
  assert.equal((await badSignatureResponse.json()).error, 'invalid_evaluator_signature');

  const wrongScope = await fetch(baseUrl + '/api/v1/organizations/org-2/model-candidates/' + candidate.id + '/evaluations?siteId=site-1', { headers: auth() });
  assert.equal(wrongScope.status, 403);
  const noEvalPermission = await post(path, { ...report, runId: 'evaluation-run-3', nonce: randomBytes(32).toString('base64url') }, { permissions: ['site:read', 'model:read'] });
  assert.equal(noEvalPermission.status, 403);

  const audit = await fetch(baseUrl + '/api/v1/organizations/org-1/audit?siteId=site-1', { headers: auth() });
  assert.equal(audit.status, 200);
  const actions = (await audit.json()).events.filter(event => event.resourceType === 'model_candidate' && event.resourceId === candidate.id).map(event => event.action);
  assert.ok(actions.includes('model_candidate.evaluation_passed'));
});
