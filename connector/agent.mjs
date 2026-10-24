import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalizeConnectorTelemetry } from '../server/spais/connectorTelemetry.mjs';
import { acknowledgeTelemetry, enqueueTelemetry, getTelemetryQueueStatus } from './offlineQueue.mjs';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_RECORDER_RESPONSE_BYTES = 64 * 1024;
const MAX_CAMERA_REPORTS_PER_POLL = 32;

function connectorError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function validateUrl(value, { allowHttp = false, allowHttpLocalhost = false } = {}) {
  let url;
  try { url = new URL(value); } catch { throw connectorError('invalid_endpoint_url'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash ||
      [...url.searchParams.keys()].some(key => /(token|secret|password|credential|api.?key|access.?key)/i.test(key))) {
    throw connectorError('unsafe_endpoint_url');
  }
  if (url.protocol === 'http:' && !allowHttp &&
      !(allowHttpLocalhost && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw connectorError('https_required');
  }
  return url;
}

function validatePrivateKey(pem) {
  let key;
  try { key = createPrivateKey(pem); } catch { throw connectorError('invalid_private_key'); }
  if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
    throw connectorError('rsa_2048_or_stronger_required');
  }
  return key;
}

export async function generateConnectorIdentity(privateKeyPath) {
  if (typeof privateKeyPath !== 'string' || !privateKeyPath.trim()) {
    throw connectorError('private_key_path_required');
  }
  const absolutePath = resolve(privateKeyPath);
  await mkdir(dirname(absolutePath), { recursive: true });
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  try {
    await writeFile(absolutePath, privateKeyPem, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await chmod(absolutePath, 0o600).catch(() => {});
  } catch (error) {
    if (error.code === 'EEXIST') throw connectorError('private_key_file_already_exists');
    throw error;
  }
  return {
    privateKeyPath: absolutePath,
    publicKeyJwk: pair.publicKey.export({ format: 'jwk' })
  };
}

export async function loadConnectorPrivateKey(privateKeyPath) {
  if (typeof privateKeyPath !== 'string' || !privateKeyPath.trim()) {
    throw connectorError('private_key_path_required');
  }
  const pem = await readFile(resolve(privateKeyPath), 'utf8');
  return validatePrivateKey(pem);
}

export function createEnrollmentProof({ enrollmentId, challenge, privateKey }) {
  if (!ID_PATTERN.test(enrollmentId || '') ||
      typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{40,64}$/.test(challenge)) {
    throw connectorError('invalid_enrollment_challenge');
  }
  const key = typeof privateKey === 'string' || Buffer.isBuffer(privateKey)
    ? validatePrivateKey(privateKey)
    : privateKey;
  return sign('RSA-SHA256', Buffer.from(enrollmentId + '.' + challenge), key).toString('base64url');
}

export function createSignedTelemetry({
  organizationId, siteId, connectorId, eventType, payload, privateKey, now = new Date(), deliveryId = randomUUID()
}) {
  if (![organizationId, siteId, connectorId].every(value => ID_PATTERN.test(value || ''))) {
    throw connectorError('invalid_connector_scope');
  }
  const key = typeof privateKey === 'string' || Buffer.isBuffer(privateKey)
    ? validatePrivateKey(privateKey)
    : privateKey;
  const message = {
    organizationId, siteId, connectorId,
    timestamp: now.toISOString(),
    nonce: randomBytes(24).toString('base64url'),
    deliveryId,
    eventType, payload
  };
  message.signature = sign('RSA-SHA256', canonicalizeConnectorTelemetry(message), key).toString('base64url');
  return message;
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal, redirect: 'error' });
  } catch (error) {
    if (error?.name === 'AbortError') throw connectorError('request_timeout');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(fetchImpl, url, body, timeoutMs) {
  const response = await fetchWithTimeout(fetchImpl, url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store'
  }, timeoutMs);
  let responseBody = {};
  try { responseBody = await response.json(); } catch {}
  if (!response.ok) {
    throw connectorError('spais_request_rejected', 'SPAIS request rejected with HTTP ' + response.status);
  }
  return responseBody;
}

export async function completeConnectorEnrollment({
  serverUrl, enrollmentId, challenge, privateKey, allowHttp = false, allowHttpLocalhost = false,
  fetchImpl = fetch, timeoutMs = 5000
}) {
  const base = validateUrl(serverUrl, { allowHttp, allowHttpLocalhost }).toString().replace(/\/$/, '');
  const signature = createEnrollmentProof({ enrollmentId, challenge, privateKey });
  return postJson(fetchImpl, base + '/api/v1/connector-enrollments/' + encodeURIComponent(enrollmentId) + '/complete', {
    challenge, signature
  }, timeoutMs);
}

async function readRecorderSnapshot({ url, bearerToken, allowHttp, fetchImpl, timeoutMs }) {
  validateUrl(url, { allowHttp });
  const headers = { accept: 'application/json' };
  if (bearerToken) headers.authorization = 'Bearer ' + bearerToken;
  const response = await fetchWithTimeout(fetchImpl, url, {
    method: 'GET', headers, cache: 'no-store'
  }, timeoutMs);
  if (!response.ok) throw connectorError('recorder_endpoint_rejected', 'Recorder status endpoint returned HTTP ' + response.status);
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_RECORDER_RESPONSE_BYTES) throw connectorError('recorder_response_too_large');
  let snapshot;
  try { snapshot = JSON.parse(text); } catch { throw connectorError('invalid_recorder_response'); }
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
      Object.keys(snapshot).some(key => !['cameraHealth', 'recordingCoverage'].includes(key))) {
    throw connectorError('invalid_recorder_response');
  }
  const cameraHealth = snapshot.cameraHealth ?? [];
  const recordingCoverage = snapshot.recordingCoverage ?? [];
  if (!Array.isArray(cameraHealth) || !Array.isArray(recordingCoverage) ||
      cameraHealth.length > MAX_CAMERA_REPORTS_PER_POLL ||
      recordingCoverage.length > MAX_CAMERA_REPORTS_PER_POLL) {
    throw connectorError('invalid_recorder_response');
  }
  if (recordingCoverage.some(item =>
    !item || typeof item !== 'object' || typeof item.evidenceDigest !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(item.evidenceDigest)
  )) throw connectorError('recorder_evidence_digest_required');
  return { cameraHealth, recordingCoverage };
}

async function drainTelemetryQueue(config, privateKey, fetchImpl, now, results) {
  let queue = await readTelemetryQueue(config.queuePath);
  let deliveryError = null;
  while (queue.length) {
    const entry = queue[0];
    const message = createSignedTelemetry({
      organizationId: config.organizationId, siteId: config.siteId,
      connectorId: config.connectorId, eventType: entry.eventType,
      payload: entry.payload, privateKey, now: now(), deliveryId: entry.deliveryId
    });
    try {
      const response = await postJson(fetchImpl, config._telemetryUrl, message, config._timeoutMs);
      results.push({ eventType: entry.eventType, accepted: true, duplicate: response.receipt?.duplicate === true,
        receiptId: response.receipt?.telemetryId ?? null, deliveryId: entry.deliveryId });
      queue = await acknowledgeTelemetry(config.queuePath, entry.deliveryId);
    } catch (error) {
      deliveryError = error.code || 'connector_delivery_failed';
      break;
    }
  }
  return { queuedCount: queue.length, deliveryError };
}

export async function runConnectorOnce(config, { fetchImpl = fetch, now = () => new Date() } = {}) {
  const serverUrl = validateUrl(config.serverUrl, {
    allowHttp: config.allowInsecureServerHttp === true,
    allowHttpLocalhost: config.allowHttpLocalhost === true
  }).toString().replace(/\/$/, '');
  const requiredIds = [config.organizationId, config.siteId, config.connectorId];
  if (!requiredIds.every(value => ID_PATTERN.test(value || ''))) throw connectorError('invalid_connector_scope');
  const privateKey = typeof config.privateKey === 'string' || Buffer.isBuffer(config.privateKey)
    ? validatePrivateKey(config.privateKey)
    : config.privateKey;
  if (!privateKey || privateKey.asymmetricKeyType !== 'rsa') throw connectorError('private_key_required');
  const timeoutMs = Number.isInteger(config.timeoutMs) ? Math.max(1000, Math.min(15000, config.timeoutMs)) : 5000;
  const telemetryUrl = serverUrl + '/api/v1/connectors/' + encodeURIComponent(config.connectorId) + '/telemetry';
  const results = [];
  const queuePath = typeof config.queuePath === 'string' && config.queuePath.trim() ? config.queuePath : null;

  const send = async (eventType, payload) => {
    if (queuePath) {
      await enqueueTelemetry(queuePath, [{ eventType, payload }], now());
      return drainTelemetryQueue({
        ...config, queuePath, _telemetryUrl: telemetryUrl, _timeoutMs: timeoutMs
      }, privateKey, fetchImpl, now, results);
    }
    const message = createSignedTelemetry({
      organizationId: config.organizationId, siteId: config.siteId,
      connectorId: config.connectorId, eventType, payload, privateKey, now: now()
    });
    const response = await postJson(fetchImpl, telemetryUrl, message, timeoutMs);
    results.push({ eventType, accepted: true, receiptId: response.receipt?.telemetryId ?? null });
    return { queuedCount: 0, deliveryError: null };
  };

  let lastDelivery = await send('connector.heartbeat', {
    status: 'healthy',
    ...(typeof config.version === 'string' ? { version: config.version.slice(0, 64) } : {})
  });

  if (config.recorderStatusUrl) {
    const snapshot = await readRecorderSnapshot({
      url: config.recorderStatusUrl,
      bearerToken: config.recorderBearerToken,
      allowHttp: config.allowInsecureRecorderHttp === true,
      fetchImpl, timeoutMs
    });
    for (const payload of snapshot.cameraHealth) lastDelivery = await send('camera.health', payload);
    for (const payload of snapshot.recordingCoverage) lastDelivery = await send('recorder.recording_coverage', payload);
  }

  const queueStatus = queuePath ? await getTelemetryQueueStatus(queuePath, now()) : null;
  const deliveryError = queuePath ? (lastDelivery.deliveryError || null) : null;
  return {
    acceptedCount: results.length,
    results,
    observedAt: now().toISOString(),
    ...(queueStatus ? { ...queueStatus, deliveryError, deliveryMode: 'durable-at-least-once' } : {})
  };
}

function readConfigFromEnvironment() {
  const required = name => {
    const value = process.env[name];
    if (!value) throw connectorError('missing_environment_variable', 'Missing required environment variable: ' + name);
    return value;
  };
  return {
    serverUrl: required('SPAIS_SERVER_URL'),
    organizationId: required('SPAIS_ORGANIZATION_ID'),
    siteId: required('SPAIS_SITE_ID'),
    connectorId: required('SPAIS_CONNECTOR_ID'),
    privateKeyPath: required('SPAIS_CONNECTOR_PRIVATE_KEY_PATH'),
    queuePath: process.env.SPAIS_CONNECTOR_QUEUE_PATH || (required('SPAIS_CONNECTOR_PRIVATE_KEY_PATH') + '.queue.json'),
    recorderStatusUrl: process.env.SPAIS_RECORDER_STATUS_URL,
    recorderBearerToken: process.env.SPAIS_RECORDER_BEARER_TOKEN,
    allowInsecureServerHttp: process.env.SPAIS_ALLOW_INSECURE_SERVER_HTTP === 'true',
    allowInsecureRecorderHttp: process.env.SPAIS_RECORDER_ALLOW_HTTP === 'true',
    version: 'spais-edge-agent/0.1.0',
    pollSeconds: Math.max(15, Math.min(300, Number(process.env.SPAIS_CONNECTOR_POLL_SECONDS) || 30))
  };
}

async function main() {
  const command = process.argv[2] || 'run';
  const keyPath = process.env.SPAIS_CONNECTOR_PRIVATE_KEY_PATH;
  if (command === 'generate-key') {
    const identity = await generateConnectorIdentity(keyPath);
    process.stdout.write(JSON.stringify({
      privateKeyPath: identity.privateKeyPath,
      publicKeyJwk: identity.publicKeyJwk,
      instruction: 'Register this public JWK with the authorized SPAIS operator. Keep the private key on this customer-controlled host.'
    }, null, 2) + '\n');
    return;
  }
  const config = readConfigFromEnvironment();
  const privateKey = await loadConnectorPrivateKey(config.privateKeyPath);
  if (command === 'complete-enrollment') {
    const result = await completeConnectorEnrollment({
      serverUrl: config.serverUrl,
      enrollmentId: requiredEnvironment('SPAIS_ENROLLMENT_ID'),
      challenge: requiredEnvironment('SPAIS_ENROLLMENT_CHALLENGE'),
      privateKey,
      allowHttp: config.allowInsecureServerHttp,
      allowHttpLocalhost: config.allowInsecureServerHttp
    });
    process.stdout.write(JSON.stringify({ completed: true, enrollmentId: result.enrollment?.enrollmentId ?? 'completed' }) + '\n');
    return;
  }
  if (command === 'run-once') {
    const result = await runConnectorOnce({ ...config, privateKey });
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  if (command !== 'run') throw connectorError('unknown_command', 'Use generate-key, complete-enrollment, run-once, or run.');
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  while (!stopping) {
    try {
      const result = await runConnectorOnce({ ...config, privateKey });
      process.stdout.write(JSON.stringify({ acceptedCount: result.acceptedCount, queuedCount: result.queuedCount ?? 0, queuedBytes: result.queuedBytes ?? 0, oldestQueuedAgeSeconds: result.oldestQueuedAgeSeconds ?? 0, deliveryError: result.deliveryError ?? null, deliveryMode: result.deliveryMode || 'direct', observedAt: result.observedAt }) + '\n');
    } catch (error) {
      // Never print tokens, payloads, private-key material, or full URLs that may contain credentials.
      process.stderr.write(JSON.stringify({ error: error.code || 'connector_run_failed' }) + '\n');
    }
    if (stopping) break;
    await new Promise(resolve => setTimeout(resolve, config.pollSeconds * 1000));
  }
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw connectorError('missing_environment_variable', 'Missing required environment variable: ' + name);
  return value;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(JSON.stringify({ error: error.code || 'connector_start_failed', message: error.message }) + '\n');
    process.exitCode = 1;
  });
}
