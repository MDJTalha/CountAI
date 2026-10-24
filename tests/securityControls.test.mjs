import test from 'node:test';
import assert from 'node:assert/strict';
import { applySecurityHeaders, createApiRateLimiter, getClientRateLimitKey } from '../server/securityControls.mjs';

test('rate limiter allows the configured request budget and resets after its window', () => {
  let now = 10_000;
  const limiter = createApiRateLimiter({ windowMs: 1_000, apiLimit: 2, writeLimit: 1, now: () => now });
  assert.equal(limiter.check({ key: 'client-a' }).allowed, true);
  assert.equal(limiter.check({ key: 'client-a' }).remaining, 0);
  const blocked = limiter.check({ key: 'client-a' });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 1);
  assert.equal(limiter.check({ key: 'client-b', isWrite: true }).allowed, true);
  assert.equal(limiter.check({ key: 'client-b', isWrite: true }).allowed, false);
  now += 1_000;
  assert.equal(limiter.check({ key: 'client-a' }).allowed, true);
});

test('rate limiter bounds tracked client keys', () => {
  const limiter = createApiRateLimiter({ maxTrackedKeys: 2, now: () => 100 });
  limiter.check({ key: 'a' });
  limiter.check({ key: 'b' });
  limiter.check({ key: 'c' });
  assert.equal(limiter.trackedKeys, 2);
});

test('client key ignores untrusted forwarded headers', () => {
  assert.equal(getClientRateLimitKey({
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'x-forwarded-for': '203.0.113.99' }
  }), '127.0.0.1');
});

test('security headers are restrictive without forcing HSTS for local HTTP', () => {
  const headers = new Map();
  const response = { setHeader: (name, value) => headers.set(name, value) };
  applySecurityHeaders(response);
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.equal(headers.get('x-frame-options'), 'DENY');
  assert.equal(headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(headers.has('cache-control'), false);
  assert.equal(headers.has('strict-transport-security'), false);
  applySecurityHeaders(response, { enableHsts: true });
  assert.match(headers.get('strict-transport-security'), /max-age=31536000/);
});
