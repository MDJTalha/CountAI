import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProductionConfig } from '../server/productionConfig.mjs';

const validProduction = {
  NODE_ENV: 'production',
  SPAIS_EVENTS_DB_PATH: '/var/lib/countai/events.sqlite',
  SPAIS_AUTH_ISSUER: 'https://identity.example.test/',
  SPAIS_AUTH_AUDIENCE: 'countai-api',
  SPAIS_AUTH_JWKS_URL: 'https://identity.example.test/.well-known/jwks.json',
  COUNTAI_BACKUP_DIR: '/var/backups/countai',
  COUNTAI_ENABLE_HSTS: 'true',
  COUNTAI_LEARNING_SOURCE_RETENTION_DAYS: '90'
};

test('production configuration gate accepts complete, HTTPS-backed OIDC configuration', () => {
  const report = validateProductionConfig(validProduction);
  assert.equal(report.mode, 'production');
  assert.equal(report.valid, true);
  assert.deepEqual(report.errors, []);
});

test('production configuration gate fails closed when persistent storage or trusted auth is missing', () => {
  const report = validateProductionConfig({
    NODE_ENV: 'production',
    SPAIS_EVENTS_DB_PATH: ':memory:',
    COUNTAI_BACKUP_DIR: '/var/backups/countai'
  });
  assert.equal(report.valid, false);
  assert.ok(report.errors.some(error => error.code === 'persistent_database_required'));
  assert.ok(report.errors.some(error => error.code === 'auth_issuer_required'));
  assert.ok(report.errors.some(error => error.code === 'trusted_token_verifier_required'));
});

test('production configuration gate rejects non-HTTPS JWKS and weak HS256 secrets', () => {
  const nonHttps = validateProductionConfig({
    ...validProduction,
    SPAIS_AUTH_JWKS_URL: 'http://identity.example.test/jwks'
  });
  assert.ok(nonHttps.errors.some(error => error.code === 'jwks_https_required'));

  const weakSecret = validateProductionConfig({
    ...validProduction,
    SPAIS_AUTH_JWKS_URL: '',
    SPAIS_AUTH_HS256_SECRET: 'short'
  });
  assert.ok(weakSecret.errors.some(error => error.code === 'hs256_secret_too_short'));
});

test('production configuration gate warns when retention is disabled and never prints secret values', () => {
  const report = validateProductionConfig({
    ...validProduction,
    COUNTAI_LEARNING_SOURCE_RETENTION_DAYS: '0',
    SPAIS_AUTH_HS256_SECRET: '0123456789abcdef0123456789abcdef',
    SPAIS_AUTH_JWKS_URL: ''
  });
  assert.equal(report.valid, true);
  assert.ok(report.warnings.some(warning => warning.includes('expiry is disabled')));
  assert.ok(!JSON.stringify(report).includes('0123456789abcdef'));
});

test('non-production runs are explicit no-op checks', () => {
  const report = validateProductionConfig({ NODE_ENV: 'test' });
  assert.equal(report.valid, true);
  assert.equal(report.skipped, true);
});
