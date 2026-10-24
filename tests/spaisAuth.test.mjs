import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifySpaisBearerToken } from '../server/spais/auth.mjs';

const config = {
  secret: 'test-only-secret-not-for-production',
  issuer: 'https://identity.example.test/',
  audience: 'spais-api',
  nowSeconds: 1_800_000_000
};

function token(claims, header = { alg: 'HS256', typ: 'JWT' }, secret = config.secret) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const h = encode(header);
  const p = encode(claims);
  const signature = createHmac('sha256', secret).update(h + '.' + p).digest('base64url');
  return `${h}.${p}.${signature}`;
}

const validClaims = {
  iss: config.issuer,
  aud: config.audience,
  sub: 'operator-1',
  exp: config.nowSeconds + 300,
  organizationIds: ['org-1'],
  sitesByOrganization: { 'org-1': ['site-1'] },
  permissions: ['camera:read']
};

test('fails closed when auth configuration or bearer token is missing', () => {
  assert.deepEqual(verifySpaisBearerToken('Bearer anything', { secret: '', issuer: config.issuer, audience: config.audience }), {
    authenticated: false, reason: 'authentication_not_configured'
  });
  assert.equal(verifySpaisBearerToken(undefined, config).reason, 'bearer_token_required');
});

test('accepts a correctly signed token and returns only normalized principal claims', () => {
  const result = verifySpaisBearerToken('Bearer ' + token(validClaims), config);
  assert.equal(result.authenticated, true);
  assert.deepEqual(result.principal, {
    subjectId: 'operator-1',
    organizationIds: ['org-1'],
    sitesByOrganization: { 'org-1': ['site-1'] },
    permissions: ['camera:read']
  });
});

test('rejects invalid signature, issuer and audience', () => {
  assert.equal(verifySpaisBearerToken('Bearer ' + token(validClaims, undefined, 'wrong-secret'), config).reason, 'invalid_signature');
  assert.equal(verifySpaisBearerToken('Bearer ' + token({ ...validClaims, iss: 'wrong' }), config).reason, 'issuer_mismatch');
  assert.equal(verifySpaisBearerToken('Bearer ' + token({ ...validClaims, aud: 'wrong' }), config).reason, 'audience_mismatch');
});

test('rejects expired, missing-expiry and malformed tenant claims', () => {
  assert.equal(verifySpaisBearerToken('Bearer ' + token({ ...validClaims, exp: config.nowSeconds }), config).reason, 'token_expired_or_missing_exp');
  const { exp, ...noExpiry } = validClaims;
  assert.equal(verifySpaisBearerToken('Bearer ' + token(noExpiry), config).reason, 'token_expired_or_missing_exp');
  assert.equal(verifySpaisBearerToken('Bearer ' + token({ ...validClaims, organizationIds: 'org-1' }), config).reason, 'tenant_claims_required');
});

test('rejects unsupported algorithms and malformed tokens', () => {
  assert.equal(verifySpaisBearerToken('Bearer ' + token(validClaims, { alg: 'none', typ: 'JWT' }), config).reason, 'unsupported_token');
  assert.equal(verifySpaisBearerToken('Bearer abc.def', config).reason, 'malformed_token');
});


test('rejects oversized tokens and unsupported critical JOSE headers', () => {
  assert.equal(verifySpaisBearerToken('Bearer ' + 'a'.repeat(16 * 1024 + 1), config).reason, 'token_size_invalid');
  assert.equal(verifySpaisBearerToken('Bearer ' + token(validClaims, { alg: 'HS256', typ: 'JWT', crit: ['exp'] }), config).reason, 'unsupported_token');
  assert.equal(verifySpaisBearerToken('Bearer ' + token(validClaims, { alg: 'HS256', typ: 'JWT', b64: false }), config).reason, 'unsupported_token');
});

test('rejects duplicate or malformed tenant scope claims', () => {
  assert.equal(verifySpaisBearerToken('Bearer ' + token({ ...validClaims, organizationIds: ['org-1', 'org-1'] }), config).reason, 'invalid_organization_claim');
  assert.equal(verifySpaisBearerToken('Bearer ' + token({ ...validClaims, sitesByOrganization: { 'org-other': ['site-1'] } }), config).reason, 'invalid_site_claim');
  assert.equal(verifySpaisBearerToken('Bearer ' + token({ ...validClaims, sitesByOrganization: { 'org-1': ['bad site'] } }), config).reason, 'invalid_site_claim');
});
