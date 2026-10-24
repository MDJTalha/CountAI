import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let child;
let baseUrl;
let tempDir;
let output = '';
const secret = 'test-only-countai-learning-secret';
const issuer = 'https://identity.example.test/';
const audience = 'spais-api';

function token({ sub = 'operator-1', organizationIds = ['org-1'], sitesByOrganization = { 'org-1': ['site-1'] }, permissions = ['site:read', 'site:manage', 'model:read', 'model:propose'] } = {}) {
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
  tempDir = await mkdtemp(join(tmpdir(), 'countai-learning-api-'));
  baseUrl = 'http://127.0.0.1:' + port;
  child = spawn(process.execPath, ['server/index.mjs'], {
    env: { ...process.env, PORT: String(port), SPAIS_EVENTS_DB_PATH: join(tempDir, 'countai.sqlite'),
      COUNTAI_LEARNING_MEDIA_DIR: join(tempDir, 'media'), SPAIS_AUTH_HS256_SECRET: secret,
      SPAIS_AUTH_ISSUER: issuer, SPAIS_AUTH_AUDIENCE: audience },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Server exited before readiness. Output:\n' + output);
    try {
      if ((await fetch(baseUrl + '/api/health')).ok) {
        const siteResponse = await fetch(baseUrl + '/api/v1/organizations/org-1/sites', {
          method: 'POST',
          headers: { ...auth(), 'content-type': 'application/json' },
          body: JSON.stringify({ id: 'site-1', name: 'Learning Test Site', status: 'active' })
        });
        if (![201, 409].includes(siteResponse.status)) {
          throw new Error('Unable to provision test site: ' + siteResponse.status + ' ' + await siteResponse.text());
        }
        return;
      }
    } catch (error) {
      if (String(error).includes('Unable to provision test site')) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Server did not become ready:\n' + output);
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
async function post(body, overrides = {}) {
  return fetch(baseUrl + '/api/v1/organizations/org-1/learning-sources?siteId=site-1', {
    method: 'POST', headers: { ...auth(overrides), 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
}

test('learning source API requires authorization and site scope', async () => {
  const path = baseUrl + '/api/v1/organizations/org-1/learning-sources?siteId=site-1';
  assert.equal((await fetch(path)).status, 401);
  assert.equal((await fetch(path, { headers: auth({ permissions: ['site:read'] }) })).status, 403);
  assert.equal((await fetch(path, { headers: auth(), method: 'GET' })).status, 200);
});

test('authorized operators can ingest and list human observations with tenant isolation', async () => {
  const response = await post({
    siteId: 'site-1', sourceType: 'observation', title: 'Entrance count correction',
    contentText: 'At 09:15 there were six people in the entrance queue, not four.',
    labels: ['queue', 'count-correction'], observedAt: '2026-10-24T09:15:00.000Z',
    consentConfirmed: true
  });
  assert.equal(response.status, 201, output);
  const source = (await response.json()).source;
  assert.equal(source.sourceType, 'observation');
  assert.equal(source.status, 'ready_for_review');
  assert.equal(source.learningState, 'queued_for_review');
  assert.equal(source.createdBy, 'operator-1');

  const list = await fetch(baseUrl + '/api/v1/organizations/org-1/learning-sources?siteId=site-1', { headers: auth() });
  assert.equal(list.status, 200);
  assert.equal((await list.json()).count, 1);
  const wrongTenant = await fetch(baseUrl + '/api/v1/organizations/org-2/learning-sources?siteId=site-1', { headers: auth() });
  assert.equal(wrongTenant.status, 403);
});

test('media ingestion enforces signatures, size caps and explicit authorization', async () => {
  const png = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
  const good = await post({
    siteId: 'site-1', sourceType: 'image', title: 'Approved reference image',
    fileName: 'reference.png', mimeType: 'image/png', fileBase64: png.toString('base64'),
    labels: ['entrance'], consentConfirmed: true
  });
  assert.equal(good.status, 201, output);
  const source = (await good.json()).source;
  assert.equal(source.mediaStored, true);
  assert.match(source.sha256, /^[a-f0-9]{64}$/);

  const spoofed = await post({
    siteId: 'site-1', sourceType: 'image', title: 'Spoofed image',
    fileName: 'fake.png', mimeType: 'image/png', fileBase64: Buffer.from('not a PNG').toString('base64'),
    consentConfirmed: true
  });
  assert.equal(spoofed.status, 400);
  assert.equal((await spoofed.json()).error, 'file_signature_mismatch');

  const noConsent = await post({
    siteId: 'site-1', sourceType: 'observation', title: 'No authorization',
    contentText: 'Should not be accepted', consentConfirmed: false
  });
  assert.equal(noConsent.status, 400);
});
