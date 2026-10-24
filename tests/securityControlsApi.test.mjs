import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

let child;
let baseUrl;
let output = '';

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
  baseUrl = 'http://127.0.0.1:' + port;
  child = spawn(process.execPath, ['server/index.mjs'], {
    env: { ...process.env, PORT: String(port), COUNTAI_API_RATE_LIMIT: '2', COUNTAI_WRITE_RATE_LIMIT: '1', COUNTAI_RATE_LIMIT_WINDOW_MS: '60000' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Server exited before readiness. Output:\n' + output);
    try {
      if ((await fetch(baseUrl + '/api/health')).ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Server did not become ready:\n' + output);
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 2_000))
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});

test('API responses include baseline security headers', async () => {
  const response = await fetch(baseUrl + '/api/v1/spais/contracts');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(response.headers.get('permissions-policy'), 'camera=(self), microphone=(), geolocation=()');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('API rate limits return 429, Retry-After, and security headers', async () => {
  assert.equal((await fetch(baseUrl + '/api/v1/spais/contracts')).status, 200);
  const blocked = await fetch(baseUrl + '/api/v1/spais/contracts');
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) >= 1 && Number(blocked.headers.get('retry-after')) <= 60);
  assert.equal(blocked.headers.get('x-frame-options'), 'DENY');
  assert.deepEqual(await blocked.json(), { error: 'rate_limit_exceeded', retryAfterSeconds: 60 });
});

test('health probes bypass API rate limiting', async () => {
  const response = await fetch(baseUrl + '/api/health');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});
