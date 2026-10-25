import { createHmac, timingSafeEqual } from 'node:crypto';

function decodeSegment(segment) {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function constantTimeStringEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Verify a compact HS256 bearer token issued by a trusted identity service.
 * Configure SPAIS_AUTH_HS256_SECRET, SPAIS_AUTH_ISSUER and SPAIS_AUTH_AUDIENCE
 * on the server only. This does not provide a login or token-issuing endpoint.
 */
export function verifySpaisBearerToken(authorization, {
  secret = process.env.SPAIS_AUTH_HS256_SECRET,
  issuer = process.env.SPAIS_AUTH_ISSUER,
  audience = process.env.SPAIS_AUTH_AUDIENCE,
  nowSeconds = Math.floor(Date.now() / 1000)
} = {}) {
  const deny = reason => ({ authenticated: false, reason });
  if (!secret || !issuer || !audience) return deny('authentication_not_configured');
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
    return deny('bearer_token_required');
  }

  const token = authorization.slice(7).trim();
  // Bound parsing work and reject oversized credentials before decoding JSON.
  if (!token || Buffer.byteLength(token, 'utf8') > 16 * 1024) return deny('token_size_invalid');
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(part => !part)) return deny('malformed_token');

  const [encodedHeader, encodedPayload, signature] = parts;
  const header = decodeSegment(encodedHeader);
  const claims = decodeSegment(encodedPayload);
  if (!header || typeof header !== 'object' || Array.isArray(header) ||
      !claims || typeof claims !== 'object' || Array.isArray(claims) ||
      header.alg !== 'HS256' || header.typ !== 'JWT' ||
      header.crit !== undefined || header.b64 === false) {
    return deny('unsupported_token');
  }

  const expected = createHmac('sha256', secret)
    .update(encodedHeader + '.' + encodedPayload)
    .digest('base64url');
  if (!constantTimeStringEqual(signature, expected)) return deny('invalid_signature');

  if (claims.iss !== issuer) return deny('issuer_mismatch');
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(audience)) return deny('audience_mismatch');
  if (!Number.isInteger(claims.exp) || claims.exp <= nowSeconds) return deny('token_expired_or_missing_exp');
  if (claims.nbf !== undefined && (!Number.isInteger(claims.nbf) || claims.nbf > nowSeconds)) {
    return deny('token_not_yet_valid');
  }
  if (typeof claims.sub !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(claims.sub)) return deny('subject_required');
  if (!Array.isArray(claims.organizationIds) || !Array.isArray(claims.permissions)) {
    return deny('tenant_claims_required');
  }
  const validResourceId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
  if (claims.organizationIds.some(id => !validResourceId(id)) || new Set(claims.organizationIds).size !== claims.organizationIds.length) {
    return deny('invalid_organization_claim');
  }
  if (claims.permissions.some(permission => typeof permission !== 'string' || !permission.trim()) ||
      new Set(claims.permissions).size !== claims.permissions.length) {
    return deny('invalid_permission_claim');
  }
  if (claims.sitesByOrganization !== undefined) {
    if (!claims.sitesByOrganization || typeof claims.sitesByOrganization !== 'object' || Array.isArray(claims.sitesByOrganization)) {
      return deny('invalid_site_claim');
    }
    for (const [organizationId, siteIds] of Object.entries(claims.sitesByOrganization)) {
      if (!claims.organizationIds.includes(organizationId) || !Array.isArray(siteIds) ||
          siteIds.some(id => !validResourceId(id)) || new Set(siteIds).size !== siteIds.length) {
        return deny('invalid_site_claim');
      }
    }
  }

  return {
    authenticated: true,
    principal: {
      subjectId: claims.sub,
      organizationIds: claims.organizationIds,
      sitesByOrganization: claims.sitesByOrganization && typeof claims.sitesByOrganization === 'object'
        ? claims.sitesByOrganization
        : {},
      permissions: claims.permissions
    }
  };
}
