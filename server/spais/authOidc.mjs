import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { verifySpaisBearerToken } from './auth.mjs';

const jwksCache = new Map();
const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_JWKS_BYTES = 256 * 1024;
const JWKS_CACHE_MS = 5 * 60 * 1000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function decodeSegment(segment) {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function deny(reason) {
  return { authenticated: false, reason };
}

function validateClaims(claims, { issuer, audience, nowSeconds }) {
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return deny('invalid_claims');
  if (claims.iss !== issuer) return deny('issuer_mismatch');
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(audience)) return deny('audience_mismatch');
  if (!Number.isInteger(claims.exp) || claims.exp <= nowSeconds) return deny('token_expired_or_missing_exp');
  if (claims.nbf !== undefined && (!Number.isInteger(claims.nbf) || claims.nbf > nowSeconds)) return deny('token_not_yet_valid');
  if (typeof claims.sub !== 'string' || !ID_PATTERN.test(claims.sub)) return deny('subject_required');
  if (!Array.isArray(claims.organizationIds) || !Array.isArray(claims.permissions)) return deny('tenant_claims_required');
  if (claims.organizationIds.some(id => !ID_PATTERN.test(id)) ||
      new Set(claims.organizationIds).size !== claims.organizationIds.length) return deny('invalid_organization_claim');
  if (claims.permissions.some(permission => typeof permission !== 'string' || !permission.trim()) ||
      new Set(claims.permissions).size !== claims.permissions.length) return deny('invalid_permission_claim');
  if (claims.sitesByOrganization !== undefined) {
    if (!claims.sitesByOrganization || typeof claims.sitesByOrganization !== 'object' || Array.isArray(claims.sitesByOrganization)) {
      return deny('invalid_site_claim');
    }
    for (const [organizationId, siteIds] of Object.entries(claims.sitesByOrganization)) {
      if (!claims.organizationIds.includes(organizationId) || !Array.isArray(siteIds) ||
          siteIds.some(id => typeof id !== 'string' || !ID_PATTERN.test(id)) ||
          new Set(siteIds).size !== siteIds.length) return deny('invalid_site_claim');
    }
  }
  return {
    authenticated: true,
    principal: {
      subjectId: claims.sub,
      organizationIds: claims.organizationIds,
      sitesByOrganization: claims.sitesByOrganization || {},
      permissions: claims.permissions
    }
  };
}

function validateJwksUrl(value) {
  try {
    const url = new URL(value);
    const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return url.protocol === 'https:' || localHttp ? url.href : null;
  } catch {
    return null;
  }
}

async function loadJwks(url, fetcher, force = false) {
  const cached = jwksCache.get(url);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.keys;
  const response = await fetcher(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
  if (!response?.ok) throw new Error('jwks_fetch_failed');
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_JWKS_BYTES) throw new Error('jwks_response_too_large');
  const document = JSON.parse(text);
  if (!document || !Array.isArray(document.keys) || document.keys.length > 100) throw new Error('invalid_jwks');
  const keys = document.keys.filter(key =>
    key && key.kty === 'RSA' && typeof key.kid === 'string' && key.kid.length <= 256 &&
    (key.use === undefined || key.use === 'sig') && (key.alg === undefined || key.alg === 'RS256') &&
    typeof key.n === 'string' && typeof key.e === 'string'
  );
  jwksCache.set(url, { keys, expiresAt: Date.now() + JWKS_CACHE_MS });
  return keys;
}

/**
 * Async JWT verifier for OIDC/JWKS deployments. Only accepts RS256 signatures,
 * fetches keys from a server-configured HTTPS JWKS URL, refreshes on unknown kid,
 * and validates issuer/audience/expiry/tenant scope. Never follows token-supplied
 * jku/x5u URLs. If JWKS is not configured, delegates to the existing HS256 adapter.
 */
export async function verifySpaisBearerTokenAsync(authorization, {
  jwksUrl = process.env.SPAIS_AUTH_JWKS_URL,
  secret = process.env.SPAIS_AUTH_HS256_SECRET,
  issuer = process.env.SPAIS_AUTH_ISSUER,
  audience = process.env.SPAIS_AUTH_AUDIENCE,
  nowSeconds = Math.floor(Date.now() / 1000),
  fetcher = globalThis.fetch
} = {}) {
  if (!jwksUrl) return verifySpaisBearerToken(authorization, { secret, issuer, audience, nowSeconds });
  if (!issuer || !audience) return deny('authentication_not_configured');
  const trustedUrl = validateJwksUrl(jwksUrl);
  if (!trustedUrl) return deny('invalid_jwks_url');
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return deny('bearer_token_required');
  const token = authorization.slice(7).trim();
  if (!token || Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES) return deny('token_size_invalid');
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(part => !part)) return deny('malformed_token');
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeSegment(encodedHeader);
  const claims = decodeSegment(encodedPayload);
  if (!header || typeof header !== 'object' || Array.isArray(header) ||
      header.alg !== 'RS256' || header.typ !== 'JWT' || typeof header.kid !== 'string' ||
      !header.kid || header.kid.length > 256 || header.crit !== undefined || header.jku !== undefined || header.x5u !== undefined ||
      header.b64 === false) return deny('unsupported_token');

  try {
    let keys = await loadJwks(trustedUrl, fetcher);
    let jwk = keys.find(key => key.kid === header.kid);
    if (!jwk) {
      keys = await loadJwks(trustedUrl, fetcher, true);
      jwk = keys.find(key => key.kid === header.kid);
    }
    if (!jwk) return deny('signing_key_not_found');
    const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
    const signature = Buffer.from(encodedSignature, 'base64url');
    const validSignature = verifySignature(
      'RSA-SHA256',
      Buffer.from(encodedHeader + '.' + encodedPayload),
      publicKey,
      signature
    );
    if (!validSignature) return deny('invalid_signature');
    return validateClaims(claims, { issuer, audience, nowSeconds });
  } catch {
    return deny('jwks_unavailable_or_invalid');
  }
}

/** Test-only helper to isolate JWKS cache between test cases. */
export function clearSpaisJwksCacheForTests() {
  jwksCache.clear();
}
