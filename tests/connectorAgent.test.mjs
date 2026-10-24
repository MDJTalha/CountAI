import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateConnectorIdentity,
  loadConnectorPrivateKey,
  createEnrollmentProof,
  createSignedTelemetry,
  runConnectorOnce
} from '../connector/agent.mjs';
import { canonicalizeConnectorTelemetry } from '../server/spais/connectorTelemetry.mjs';

test('edge identity is generated locally with a private key file and public JWK export', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spais-agent-key-'));
  const keyPath = join(dir, 'connector-private.pem');
  try {
    const identity = await generateConnectorIdentity(keyPath);
    assert.equal(identity.publicKeyJwk.kty, 'RSA');
    assert.ok(identity.publicKeyJwk.n);
    const mode = (await stat(keyPath)).mode & 0o777;
    if (process.platform !== 'win32') assert.equal(mode, 0o600);
    const privateKey = await loadConnectorPrivateKey(keyPath);
    const challenge = 'a'.repeat(43);
    const proof = createEnrollmentProof({ enrollmentId: 'enrollment-1', challenge, privateKey });
    assert.ok(proof.length > 250);
    await assert.rejects(() => generateConnectorIdentity(keyPath), error => error.code === 'private_key_file_already_exists');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('edge telemetry is signed over canonical protocol bytes', () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const message = createSignedTelemetry({
    organizationId: 'org-1', siteId: 'site-1', connectorId: 'connector-1',
    eventType: 'connector.heartbeat', payload: { version: 'test', status: 'healthy' },
    privateKey: pair.privateKey, now: new Date('2026-10-24T10:00:00.000Z')
  });
  assert.equal(message.timestamp, '2026-10-24T10:00:00.000Z');
  assert.ok(verify(
    'RSA-SHA256', canonicalizeConnectorTelemetry(message), pair.publicKey,
    Buffer.from(message.signature, 'base64url')
  ));
});

test('edge agent polls only the configured recorder endpoint and sends signed metadata reports', async () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url) === 'https://recorder.example.test/status') {
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({
          cameraHealth: [{ cameraId: 'camera-1', status: 'online', observedAt: '2026-10-24T10:00:00.000Z' }],
          recordingCoverage: [{
            cameraId: 'camera-1',
            windowStart: '2026-10-24T09:00:00.000Z',
            windowEnd: '2026-10-24T10:00:00.000Z',
            recordedSeconds: 3500,
            expectedSeconds: 3600,
            evidenceDigest: 'b'.repeat(64)
          }]
        })
      };
    }
    return { ok: true, status: 202, json: async () => ({ receipt: { telemetryId: 'receipt-1' } }) };
  };
  const result = await runConnectorOnce({
    serverUrl: 'https://spais.example.test',
    organizationId: 'org-1', siteId: 'site-1', connectorId: 'connector-1',
    privateKey: pair.privateKey, recorderStatusUrl: 'https://recorder.example.test/status',
    recorderBearerToken: 'recorder-secret',
    now: () => new Date('2026-10-24T10:00:00.000Z')
  }, { fetchImpl, now: () => new Date('2026-10-24T10:00:00.000Z') });

  assert.equal(result.acceptedCount, 3);
  assert.equal(calls.length, 4);
  assert.equal(calls[0].url, 'https://spais.example.test/api/v1/connectors/connector-1/telemetry');
  assert.equal(calls[1].url, 'https://recorder.example.test/status');
  assert.equal(calls[1].options.headers.authorization, 'Bearer recorder-secret');
  for (const call of calls.filter(item => item.url.includes('/telemetry'))) {
    const message = JSON.parse(call.options.body);
    assert.equal(call.options.headers.authorization, undefined);
    assert.ok(verify(
      'RSA-SHA256', canonicalizeConnectorTelemetry(message), pair.publicKey,
      Buffer.from(message.signature, 'base64url')
    ));
  }
  assert.equal(result.results[2].eventType, 'recorder.recording_coverage');
});

test('edge agent rejects unsafe endpoint URLs and recorder payloads with extra fields', async () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await assert.rejects(() => runConnectorOnce({
    serverUrl: 'http://spais.example.test',
    organizationId: 'org-1', siteId: 'site-1', connectorId: 'connector-1',
    privateKey: pair.privateKey
  }), error => error.code === 'https_required');

  const fetchImpl = async (url) => {
    if (String(url) === 'https://recorder.example.test/status') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ frames: ['not allowed'] }) };
    }
    return { ok: true, status: 202, json: async () => ({ receipt: { telemetryId: 'receipt-1' } }) };
  };
  await assert.rejects(() => runConnectorOnce({
    serverUrl: 'https://spais.example.test',
    organizationId: 'org-1', siteId: 'site-1', connectorId: 'connector-1',
    privateKey: pair.privateKey, recorderStatusUrl: 'https://recorder.example.test/status'
  }, { fetchImpl }), error => error.code === 'invalid_recorder_response');
});
