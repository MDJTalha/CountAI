import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
import { getTelemetryQueueStatus, readTelemetryQueue, writeTelemetryQueue } from '../connector/offlineQueue.mjs';

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

  await assert.rejects(() => runConnectorOnce({
    serverUrl: 'https://spais.example.test#',
    organizationId: 'org-1', siteId: 'site-1', connectorId: 'connector-1',
    privateKey: pair.privateKey
  }), error => error.code === 'unsafe_endpoint_url');

  await assert.rejects(() => runConnectorOnce({
    serverUrl: 'https://spais.example.test',
    organizationId: 'org-1', siteId: 'site-1', connectorId: 'connector-1',
    privateKey: pair.privateKey, recorderStatusUrl: 'https://recorder.example.test/status#'
  }), error => error.code === 'unsafe_endpoint_url');

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


test('offline queue durably retries with a stable delivery ID and a fresh signed nonce', async () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const dir = await mkdtemp(join(tmpdir(), 'spais-agent-queue-'));
  const queuePath = join(dir, 'telemetry-queue.json');
  const firstAttempt = [];
  try {
    const failed = await runConnectorOnce({
      serverUrl: 'https://spais.example.test',
      organizationId: 'org-1', siteId: 'site-1', connectorId: 'connector-1',
      privateKey: pair.privateKey, queuePath
    }, {
      now: () => new Date('2026-10-24T10:00:00.000Z'),
      fetchImpl: async (_url, options) => {
        firstAttempt.push(JSON.parse(options.body));
        throw new Error('network unavailable');
      }
    });
    assert.equal(failed.acceptedCount, 0);
    assert.equal(failed.queuedCount, 1);
    assert.ok(failed.queuedBytes > 0);
    assert.equal(failed.oldestQueuedAt, '2026-10-24T10:00:00.000Z');
    assert.equal(failed.oldestQueuedAgeSeconds, 0);
    assert.equal(failed.deliveryMode, 'durable-at-least-once');
    assert.ok(firstAttempt[0].deliveryId);
    const queuedBeforeRetry = JSON.parse(await readFile(queuePath, 'utf8'));
    assert.equal(queuedBeforeRetry.length, 1);
    assert.equal(queuedBeforeRetry[0].deliveryId, firstAttempt[0].deliveryId);
    assert.equal(JSON.stringify(queuedBeforeRetry).includes('network unavailable'), false);

    const retryMessages = [];
    const recovered = await runConnectorOnce({
      serverUrl: 'https://spais.example.test',
      organizationId: 'org-1', siteId: 'site-1', connectorId: 'connector-1',
      privateKey: pair.privateKey, queuePath
    }, {
      now: () => new Date('2026-10-24T10:00:10.000Z'),
      fetchImpl: async (_url, options) => {
        const message = JSON.parse(options.body);
        retryMessages.push(message);
        return { ok: true, status: 202, json: async () => ({ receipt: { telemetryId: 'receipt-1' } }) };
      }
    });
    assert.equal(recovered.queuedCount, 0);
    assert.equal(recovered.queuedBytes, 3); // Empty JSON array plus newline.
    assert.equal(recovered.oldestQueuedAt, null);
    assert.equal(recovered.oldestQueuedAgeSeconds, 0);
    assert.equal(recovered.acceptedCount, 2);
    assert.equal(JSON.parse(await readFile(queuePath, 'utf8')).length, 0);
    assert.equal(retryMessages[0].deliveryId, firstAttempt[0].deliveryId);
    assert.notEqual(retryMessages[0].nonce, firstAttempt[0].nonce);
    assert.ok(verify(
      'RSA-SHA256', canonicalizeConnectorTelemetry(retryMessages[0]), pair.publicKey,
      Buffer.from(retryMessages[0].signature, 'base64url')
    ));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('offline queue rejects secret-bearing metadata, duplicate delivery IDs, corrupt files, and symlinks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spais-queue-validation-'));
  const queuePath = join(dir, 'queue.json');
  const targetPath = join(dir, 'target.json');
  const symlinkPath = join(dir, 'queue-link.json');
  const entry = {
    deliveryId: 'delivery-validation-0001',
    eventType: 'connector.heartbeat',
    payload: { status: 'healthy', version: 'test-agent' },
    queuedAt: '2026-10-24T10:00:00.000Z'
  };
  try {
    await assert.rejects(
      () => writeTelemetryQueue(queuePath, [{ ...entry, payload: { status: 'healthy', accessToken: 'must-not-be-stored' } }]),
      error => error.code === 'invalid_connector_queue_entry'
    );
    await assert.rejects(
      () => writeTelemetryQueue(queuePath, [entry, entry]),
      error => error.code === 'connector_queue_duplicate_delivery_id'
    );

    await writeTelemetryQueue(queuePath, [entry]);
    assert.equal((await readTelemetryQueue(queuePath))[0].deliveryId, entry.deliveryId);

    await writeTelemetryQueue(targetPath, [entry]);
    await symlink(targetPath, symlinkPath);
    await assert.rejects(
      () => readTelemetryQueue(symlinkPath),
      error => error.code === 'connector_queue_not_regular_file'
    );

    await writeFile(queuePath, Buffer.alloc(2 * 1024 * 1024 + 1, 0x78));
    await assert.rejects(
      () => readTelemetryQueue(queuePath),
      error => error.code === 'connector_queue_too_large'
    );

    await writeFile(queuePath, '{invalid-json', 'utf8');
    await assert.rejects(
      () => readTelemetryQueue(queuePath),
      error => error.code === 'connector_queue_corrupt'
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('queue status reports oldest backlog age and bounded byte usage without exposing payloads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spais-queue-status-'));
  const queuePath = join(dir, 'queue.json');
  try {
    await writeTelemetryQueue(queuePath, [
      { deliveryId: 'delivery-status-1', eventType: 'connector.heartbeat', payload: { status: 'healthy' }, queuedAt: '2026-10-24T10:00:00.000Z' },
      { deliveryId: 'delivery-status-2', eventType: 'camera.health', payload: { cameraId: 'camera-1', status: 'offline' }, queuedAt: '2026-10-24T10:00:30.000Z' }
    ]);
    const status = await getTelemetryQueueStatus(queuePath, new Date('2026-10-24T10:02:00.000Z'));
    assert.equal(status.queuedCount, 2);
    assert.ok(status.queuedBytes > 0 && status.queuedBytes <= 2 * 1024 * 1024);
    assert.equal(status.oldestQueuedAt, '2026-10-24T10:00:00.000Z');
    assert.equal(status.oldestQueuedAgeSeconds, 120);
    assert.equal(Object.hasOwn(status, 'payload'), false);
    const empty = await getTelemetryQueueStatus(join(dir, 'missing.json'), new Date('2026-10-24T10:02:00.000Z'));
    assert.deepEqual(empty, { queuedCount: 0, queuedBytes: 3, oldestQueuedAt: null, oldestQueuedAgeSeconds: 0 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
