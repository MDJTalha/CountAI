import { createHash, createPublicKey, randomUUID, verify as verifySignature } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isResourceId } from './contracts.mjs';

const EVENT_TYPES = new Set([
  'connector.heartbeat',
  'camera.health',
  'recorder.recording_coverage'
]);
const FORBIDDEN_FIELD = /(image|frame|video|base64|password|secret|token|credential|authorization|private.?key|api.?key|stream.?url|rtsp.?url)/i;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{256,1024}$/;
const MAX_PAYLOAD_BYTES = 8 * 1024;

function fail(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
}

function containsForbiddenField(value, depth = 0) {
  if (depth > 8) return true;
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) =>
    FORBIDDEN_FIELD.test(key) || containsForbiddenField(child, depth + 1)
  );
}

function validatePayload(eventType, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw fail('invalid_telemetry_payload');
  let serialized;
  try { serialized = canonicalJson(payload); } catch { throw fail('invalid_telemetry_payload'); }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES || containsForbiddenField(payload)) {
    throw fail('invalid_telemetry_payload');
  }

  const keys = new Set(Object.keys(payload));
  const allowed = {
    'connector.heartbeat': new Set(['status', 'uptimeSeconds', 'version']),
    'camera.health': new Set(['cameraId', 'status', 'observedAt']),
    'recorder.recording_coverage': new Set([
      'cameraId', 'windowStart', 'windowEnd', 'recordedSeconds', 'expectedSeconds', 'evidenceDigest'
    ])
  }[eventType];
  if (!allowed || [...keys].some(key => !allowed.has(key))) throw fail('invalid_telemetry_payload');

  if (eventType === 'connector.heartbeat') {
    if (!['healthy', 'degraded'].includes(payload.status)) throw fail('invalid_telemetry_payload');
    if (payload.uptimeSeconds !== undefined &&
        (!Number.isSafeInteger(payload.uptimeSeconds) || payload.uptimeSeconds < 0)) throw fail('invalid_telemetry_payload');
    if (payload.version !== undefined &&
        (typeof payload.version !== 'string' || payload.version.length > 64)) throw fail('invalid_telemetry_payload');
  } else if (eventType === 'camera.health') {
    if (!isResourceId(payload.cameraId) || !['online', 'offline', 'unknown'].includes(payload.status)) {
      throw fail('invalid_telemetry_payload');
    }
    if (payload.observedAt !== undefined &&
        (typeof payload.observedAt !== 'string' || !Number.isFinite(Date.parse(payload.observedAt)))) {
      throw fail('invalid_telemetry_payload');
    }
  } else {
    if (!isResourceId(payload.cameraId) ||
        typeof payload.windowStart !== 'string' || !Number.isFinite(Date.parse(payload.windowStart)) ||
        typeof payload.windowEnd !== 'string' || !Number.isFinite(Date.parse(payload.windowEnd)) ||
        Date.parse(payload.windowEnd) <= Date.parse(payload.windowStart) ||
        !Number.isSafeInteger(payload.recordedSeconds) || payload.recordedSeconds < 0 ||
        !Number.isSafeInteger(payload.expectedSeconds) || payload.expectedSeconds <= 0 ||
        payload.recordedSeconds > payload.expectedSeconds ||
        (payload.evidenceDigest !== undefined && !/^[a-f0-9]{64}$/i.test(payload.evidenceDigest))) {
      throw fail('invalid_telemetry_payload');
    }
  }
  return serialized;
}

/**
 * Canonical bytes signed by an enrolled connector's RSA private key.
 * Only metadata and evidence digests are accepted; raw video/images and secrets are rejected.
 */
export function canonicalizeConnectorTelemetry(message) {
  const fields = [
    message.organizationId, message.siteId, message.connectorId,
    message.timestamp, message.nonce, message.eventType,
    canonicalJson(message.payload)
  ];
  if (fields.some(value => typeof value !== 'string')) throw fail('invalid_telemetry_envelope');
  return Buffer.from('spais-connector-telemetry-v1\n' + fields.join('\n'), 'utf8');
}

export function createConnectorTelemetryReceiver({
  databasePath = process.env.SPAIS_EVENTS_DB_PATH,
  resourceStore,
  now = () => new Date(),
  maxClockSkewSeconds = 300
} = {}) {
  const path = typeof databasePath === 'string' && databasePath.trim()
    ? (databasePath === ':memory:' ? ':memory:' : resolve(databasePath))
    : null;
  let databasePromise;

  async function getDatabase() {
    if (!path) throw fail('telemetry_store_not_configured');
    if (!databasePromise) {
      databasePromise = (async () => {
        if (path !== ':memory:') await mkdir(dirname(path), { recursive: true });
        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(path);
        db.exec('PRAGMA foreign_keys = ON;');
        if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
        db.exec(`
          CREATE TABLE IF NOT EXISTS spais_connector_telemetry (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            telemetry_id TEXT NOT NULL UNIQUE,
            organization_id TEXT NOT NULL,
            site_id TEXT NOT NULL,
            connector_id TEXT NOT NULL,
            nonce TEXT NOT NULL,
            signed_timestamp TEXT NOT NULL,
            event_type TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            received_at TEXT NOT NULL,
            trust_level TEXT NOT NULL CHECK (trust_level = 'connector-signed-report'),
            UNIQUE (organization_id, site_id, connector_id, nonce)
          );
          CREATE INDEX IF NOT EXISTS idx_spais_connector_telemetry_scope
            ON spais_connector_telemetry (organization_id, site_id, connector_id, sequence DESC);
        `);
        return db;
      })().catch(error => { databasePromise = undefined; throw error; });
    }
    return databasePromise;
  }

  return {
    configured: Boolean(path),
    async accept(message) {
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw fail('invalid_telemetry_envelope');
      const { organizationId, siteId, connectorId, timestamp, nonce, eventType, payload, signature } = message;
      if (!isResourceId(organizationId) || !isResourceId(siteId) || !isResourceId(connectorId) ||
          typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp)) ||
          !NONCE_PATTERN.test(nonce || '') || !EVENT_TYPES.has(eventType) ||
          typeof signature !== 'string' || !SIGNATURE_PATTERN.test(signature)) {
        throw fail('invalid_telemetry_envelope');
      }
      const signedAt = Date.parse(timestamp);
      if (Math.abs(now().getTime() - signedAt) > maxClockSkewSeconds * 1000) throw fail('telemetry_timestamp_out_of_window');
      const payloadJson = validatePayload(eventType, payload);
      if (eventType === 'camera.health' || eventType === 'recorder.recording_coverage') {
        const camera = await resourceStore.get({
          organizationId, resourceType: 'camera', resourceId: payload.cameraId, siteId
        });
        if (!camera) throw fail('telemetry_camera_scope_mismatch');
      }
      const identity = await resourceStore.getConnectorIdentity({ organizationId, siteId, connectorId });
      if (!identity) throw fail('connector_identity_not_active');

      let publicKey;
      try { publicKey = createPublicKey({ key: identity.publicKeyJwk, format: 'jwk' }); }
      catch { throw fail('connector_identity_invalid'); }
      let signedBytes;
      try { signedBytes = canonicalizeConnectorTelemetry(message); }
      catch { throw fail('invalid_telemetry_envelope'); }
      const valid = verifySignature('RSA-SHA256', signedBytes, publicKey, Buffer.from(signature, 'base64url'));
      if (!valid) throw fail('invalid_telemetry_signature');

      const db = await getDatabase();
      const receivedAt = now().toISOString();
      const telemetryId = randomUUID();
      db.exec('BEGIN IMMEDIATE;');
      try {
        db.prepare(`
          INSERT INTO spais_connector_telemetry
            (telemetry_id, organization_id, site_id, connector_id, nonce, signed_timestamp,
             event_type, payload_json, received_at, trust_level)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'connector-signed-report')
        `).run(telemetryId, organizationId, siteId, connectorId, nonce, timestamp, eventType, payloadJson, receivedAt);
        db.exec('COMMIT;');
      } catch (error) {
        try { db.exec('ROLLBACK;'); } catch {}
        if (error.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/.test(error.message)) {
          throw fail('telemetry_replay_detected');
        }
        throw error;
      }
      return {
        telemetryId, organizationId, siteId, connectorId, eventType,
        receivedAt, trustLevel: 'connector-signed-report',
        interpretation: eventType === 'recorder.recording_coverage'
          ? 'reported_not_independently_verified'
          : 'signed_connector_report'
      };
    },
    async close() {
      if (!databasePromise) return;
      const db = await databasePromise;
      db.close();
      databasePromise = undefined;
    }
  };
}
