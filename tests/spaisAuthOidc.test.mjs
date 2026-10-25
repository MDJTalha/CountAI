import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  clearSpaisJwksCacheForTests,
  verifySpaisBearerTokenAsync
} from '../server/spais/authOidc.mjs';

const issuer = 'https://identity.example.test/';
const audience = 'spais-api';
const jwksUrl = 'https://identity.example.test/.well-known/jwks.json';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'key-1', use: 'sig', alg: 'RS256' };

function makeToken({ key = privateKey, kid = 'key-1', headerExtra = {}, claimsExtra = {} } = {}) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'RS256', typ: 'JWT', kid, ...headerExtra });
  const claims = encode({
    iss: issuer,
    aud: audience,
    sub: 'operator-1',
    exp: Math.floor(Date.now() / 1000) + 300,
    organizationIds: ['org-1'],
    sitesByOrganization: { 'org-1': ['site-1'] },
    permissions: ['site:read', 'camera:read'],
    ...claimsExtra
  });
  const signature = sign('RSA-SHA256', Buffer.from(header + '.' + claims), key).toString('base64url');
  return `${header}.${claims}.${signature}`;
}

function mockFetcher(keys, calls = { count: 0 }) {
  return async () => {
    calls.count += 1;
    return { ok: true, text: async () => JSON.stringify({ keys }) };
  };
}

test('OIDC verifier accepts a trusted RS256 token and returns validated tenant scope', async () => {
  clearSpaisJwksCacheForTests();
  const result = await verifySpaisBearerTokenAsync(`Bearer ${makeToken()}`, {
    jwksUrl, issuer, audience, fetcher: mockFetcher([jwk])
  });
  assert.equal(result.authenticated, true);
  assert.equal(result.principal.subjectId, 'operator-1');
  assert.deepEqual(result.principal.organizationIds, ['org-1']);
  assert.deepEqual(result.principal.sitesByOrganization['org-1'], ['site-1']);
});

test('OIDC verifier rejects invalid signatures, issuer, audience and expired tokens', async () => {
  clearSpaisJwksCacheForTests();
  const wrongKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const badSignature = await verifySpaisBearerTokenAsync(`Bearer ${makeToken({ key: wrongKey.privateKey })}`, {
    jwksUrl, issuer, audience, fetcher: mockFetcher([jwk])
  });
  assert.deepEqual(badSignature, { authenticated: false, reason: 'invalid_signature' });

  clearSpaisJwksCacheForTests();
  const wrongIssuer = await verifySpaisBearerTokenAsync(`Bearer ${makeToken({ claimsExtra: { iss: 'https://attacker.example/' } })}`, {
    jwksUrl, issuer, audience, fetcher: mockFetcher([jwk])
  });
  assert.deepEqual(wrongIssuer, { authenticated: false, reason: 'issuer_mismatch' });

  clearSpaisJwksCacheForTests();
  const expired = await verifySpaisBearerTokenAsync(`Bearer ${makeToken({ claimsExtra: { exp: Math.floor(Date.now() / 1000) - 1 } })}`, {
    jwksUrl, issuer, audience, fetcher: mockFetcher([jwk])
  });
  assert.deepEqual(expired, { authenticated: false, reason: 'token_expired_or_missing_exp' });
});

test('OIDC verifier refreshes JWKS once when a signing key ID is not cached', async () => {
  clearSpaisJwksCacheForTests();
  const rotated = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rotatedJwk = { ...rotated.publicKey.export({ format: 'jwk' }), kid: 'key-2', use: 'sig', alg: 'RS256' };
  const calls = { count: 0 };
  const fetcher = async () => {
    calls.count += 1;
    return { ok: true, text: async () => JSON.stringify({ keys: calls.count === 1 ? [jwk] : [jwk, rotatedJwk] }) };
  };
  const result = await verifySpaisBearerTokenAsync(`Bearer ${makeToken({ key: rotated.privateKey, kid: 'key-2' })}`, {
    jwksUrl, issuer, audience, fetcher
  });
  assert.equal(result.authenticated, true);
  assert.equal(calls.count, 2);
});

test('OIDC verifier rejects non-HTTPS remote JWKS URLs and token-supplied key URLs', async () => {
  clearSpaisJwksCacheForTests();
  const insecureUrl = await verifySpaisBearerTokenAsync(`Bearer ${makeToken()}`, {
    jwksUrl: 'http://identity.example.test/jwks', issuer, audience, fetcher: mockFetcher([jwk])
  });
  assert.deepEqual(insecureUrl, { authenticated: false, reason: 'invalid_jwks_url' });

  for (const unsafeUrl of [
    'https://user:password@identity.example.test/jwks',
    'https://identity.example.test/jwks?tenant=unexpected',
    'https://identity.example.test/jwks#alternate',
    'https://identity.example.test/jwks?',
    'https://identity.example.test/jwks#'
  ]) {
    clearSpaisJwksCacheForTests();
    const result = await verifySpaisBearerTokenAsync(`Bearer ${makeToken()}`, {
      jwksUrl: unsafeUrl, issuer, audience, fetcher: mockFetcher([jwk])
    });
    assert.deepEqual(result, { authenticated: false, reason: 'invalid_jwks_url' });
  }

  const tokenSuppliedUrl = await verifySpaisBearerTokenAsync(`Bearer ${makeToken({ headerExtra: { jku: 'https://attacker.example/jwks' } })}`, {
    jwksUrl, issuer, audience, fetcher: mockFetcher([jwk])
  });
  assert.deepEqual(tokenSuppliedUrl, { authenticated: false, reason: 'unsupported_token' });
});


test('OIDC verifier rejects private-key material in JWKS and non-string tenant IDs', async () => {
  clearSpaisJwksCacheForTests();
  const privateJwk = { ...jwk, d: privateKey.export({ format: 'jwk' }).d };
  const privateKeyResult = await verifySpaisBearerTokenAsync(`Bearer ${makeToken()}`, {
    jwksUrl, issuer, audience, fetcher: mockFetcher([privateJwk])
  });
  assert.deepEqual(privateKeyResult, { authenticated: false, reason: 'signing_key_not_found' });

  clearSpaisJwksCacheForTests();
  const invalidClaims = await verifySpaisBearerTokenAsync(`Bearer ${makeToken({ claimsExtra: { organizationIds: [123] } })}`, {
    jwksUrl, issuer, audience, fetcher: mockFetcher([jwk])
  });
  assert.deepEqual(invalidClaims, { authenticated: false, reason: 'invalid_organization_claim' });
});
