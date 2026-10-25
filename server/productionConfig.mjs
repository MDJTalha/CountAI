const fail = (code, detail) => ({ code, detail });

function positiveInteger(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Validate deployment configuration without printing secret values.
 * This is an explicit release gate; it does not test remote identity providers,
 * TLS termination, backup schedules, or actual recovery.
 */
export function validateProductionConfig(env = process.env) {
  if (env.NODE_ENV !== 'production') {
    return {
      mode: 'non-production',
      valid: true,
      skipped: true,
      errors: [],
      warnings: ['Set NODE_ENV=production to run the production configuration gate.']
    };
  }

  const errors = [];
  const warnings = [];
  if (!env.SPAIS_EVENTS_DB_PATH?.trim() || env.SPAIS_EVENTS_DB_PATH === ':memory:') {
    errors.push(fail('persistent_database_required', 'Set SPAIS_EVENTS_DB_PATH to a persistent SQLite file.'));
  }
  if (!env.SPAIS_AUTH_ISSUER?.trim()) errors.push(fail('auth_issuer_required', 'Configure SPAIS_AUTH_ISSUER.'));
  if (!env.SPAIS_AUTH_AUDIENCE?.trim()) errors.push(fail('auth_audience_required', 'Configure SPAIS_AUTH_AUDIENCE.'));

  const jwksConfigured = Boolean(env.SPAIS_AUTH_JWKS_URL?.trim());
  const hsSecret = env.SPAIS_AUTH_HS256_SECRET || '';
  if (!jwksConfigured && !hsSecret) {
    errors.push(fail('trusted_token_verifier_required', 'Configure SPAIS_AUTH_JWKS_URL or SPAIS_AUTH_HS256_SECRET.'));
  }
  if (jwksConfigured) {
    try {
      const url = new URL(env.SPAIS_AUTH_JWKS_URL);
      if (url.protocol !== 'https:') errors.push(fail('jwks_https_required', 'Production JWKS URL must use HTTPS.'));
    } catch {
      errors.push(fail('jwks_url_invalid', 'SPAIS_AUTH_JWKS_URL must be a valid HTTPS URL.'));
    }
  } else if (hsSecret) {
    if (Buffer.byteLength(hsSecret, 'utf8') < 32) {
      errors.push(fail('hs256_secret_too_short', 'Production HS256 secret must contain at least 32 UTF-8 bytes.'));
    }
    warnings.push('HS256 requires controlled secret distribution and rotation; prefer customer-approved OIDC/JWKS.');
  }

  if (!env.COUNTAI_BACKUP_DIR?.trim()) {
    errors.push(fail('backup_directory_required', 'Set COUNTAI_BACKUP_DIR to a protected backup directory.'));
  }
  if (env.COUNTAI_ENABLE_HSTS !== 'true') {
    warnings.push('HSTS is not enabled. Enable it only after HTTPS is enforced at the public gateway.');
  }
  const retention = env.COUNTAI_LEARNING_SOURCE_RETENTION_DAYS === undefined
    ? 0
    : Number(env.COUNTAI_LEARNING_SOURCE_RETENTION_DAYS);
  if (!Number.isInteger(retention) || retention < 0 || retention > 3650) {
    errors.push(fail('learning_retention_invalid', 'COUNTAI_LEARNING_SOURCE_RETENTION_DAYS must be an integer from 0 to 3650.'));
  } else if (retention === 0) {
    warnings.push('Learning-source expiry is disabled; approve a retention policy and schedule maintenance before accepting persistent learning uploads.');
  }

  for (const [name, fallback] of [
    ['COUNTAI_API_RATE_LIMIT', 120],
    ['COUNTAI_WRITE_RATE_LIMIT', 30],
    ['COUNTAI_RATE_LIMIT_WINDOW_MS', 60000],
    ['COUNTAI_HEADERS_TIMEOUT_MS', 15000],
    ['COUNTAI_REQUEST_TIMEOUT_MS', 120000],
    ['COUNTAI_KEEPALIVE_TIMEOUT_MS', 5000]
  ]) {
    if (positiveInteger(env, name, fallback) === null) {
      errors.push(fail('invalid_numeric_setting', name + ' must be a positive safe integer.'));
    }
  }

  warnings.push('This check cannot verify live TLS, identity-provider reachability, scheduled jobs, backup off-site protection, or restore success.');
  return { mode: 'production', valid: errors.length === 0, skipped: false, errors, warnings };
}
