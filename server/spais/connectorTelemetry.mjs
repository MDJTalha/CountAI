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
  if (message.deliveryId === undefined) {
    return Buffer.from('spais-connector-telemetry-v1\n' + fields.join('\n'), 'utf8');
  }
  if (typeof message.deliveryId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(message.deliveryId)) {
    throw fail('invalid_telemetry_envelope');
  }
  return Buffer.from('spais-connector-telemetry-v2\n' + fields.concat(message.deliveryId).join('\n'), 'utf8');
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
            delivery_id TEXT,
            payload_digest TEXT NOT NULL DEFAULT '',
            organization_id TEXT NOT NULL,
            site_id TEXT NOT NULL,
            connector_id TEXT NOT NULL,
            nonce TEXT NOT NULL,
            signed_timestamp TEXT NOT NULL,
            event_type TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            received_at TEXT NOT NULL,
            trust_level TEXT NOT NULL CHECK (trust_level = 'connector-signed-report')
          );
          CREATE INDEX IF NOT EXISTS idx_spais_connector_telemetry_scope
            ON spais_connector_telemetry (organization_id, site_id, connector_id, sequence DESC);
          CREATE TABLE IF NOT EXISTS spais_connector_telemetry_nonces (
            organization_id TEXT NOT NULL,
            site_id TEXT NOT NULL,
            connector_id TEXT NOT NULL,
            nonce TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            PRIMARY KEY (organization_id, site_id, connector_id, nonce)
          );
          CREATE INDEX IF NOT EXISTS idx_spais_connector_telemetry_nonces_expiry
            ON spais_connector_telemetry_nonces (expires_at);
        `);
        const telemetryColumns = new Set(db.prepare('PRAGMA table_info(spais_connector_telemetry)').all().map(row => row.name));
        if (!telemetryColumns.has('delivery_id')) db.exec('ALTER TABLE spais_connector_telemetry ADD COLUMN delivery_id TEXT;');
        if (!telemetryColumns.has('payload_digest')) db.exec("ALTER TABLE spais_connector_telemetry ADD COLUMN payload_digest TEXT NOT NULL DEFAULT '';");
        db.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_spais_telemetry_delivery_id
            ON spais_connector_telemetry (organization_id, site_id, connector_id, delivery_id)
            WHERE delivery_id IS NOT NULL;
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
          typeof signature !== 'string' || !SIGNATURE_PATTERN.test(signature) ||
          (message.deliveryId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(message.deliveryId))) {
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
      const nonceExpiresAt = new Date(signedAt + maxClockSkewSeconds * 1000).toISOString();
      const telemetryId = randomUUID();
      const payloadDigest = createHash('sha256').update(canonicalJson({
        organizationId, siteId, connectorId, eventType, payload
      })).digest('hex');
      db.exec('BEGIN IMMEDIATE;');
      try {
        // Signed timestamps are accepted only inside the clock-skew window, so expired
        // nonce records can be purged safely without reopening a replay window.
        db.prepare('DELETE FROM spais_connector_telemetry_nonces WHERE expires_at <= ?').run(receivedAt);
        db.prepare(`
          INSERT INTO spais_connector_telemetry_nonces
            (organization_id, site_id, connector_id, nonce, expires_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(organizationId, siteId, connectorId, nonce, nonceExpiresAt);
        if (message.deliveryId) {
          const existing = db.prepare(`
            SELECT telemetry_id, payload_digest, received_at, signed_timestamp
            FROM spais_connector_telemetry
            WHERE organization_id = ? AND site_id = ? AND connector_id = ? AND delivery_id = ?
          `).get(organizationId, siteId, connectorId, message.deliveryId);
          if (existing) {
            if (existing.payload_digest !== payloadDigest) throw fail('telemetry_delivery_id_conflict');
            db.exec('COMMIT;');
            return {
              telemetryId: existing.telemetry_id, organizationId, siteId, connectorId, eventType,
              receivedAt: existing.received_at, signedAt: existing.signed_timestamp,
              trustLevel: 'connector-signed-report', duplicate: true,
              interpretation: eventType === 'recorder.recording_coverage'
                ? 'reported_not_independently_verified'
                : 'signed_connector_report'
            };
          }
        }
        db.prepare(`
          INSERT INTO spais_connector_telemetry
            (telemetry_id, delivery_id, payload_digest, organization_id, site_id, connector_id,
             nonce, signed_timestamp, event_type, payload_json, received_at, trust_level)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'connector-signed-report')
        `).run(telemetryId, message.deliveryId ?? null, payloadDigest, organizationId, siteId, connectorId,
          nonce, timestamp, eventType, payloadJson, receivedAt);
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
    async list({ organizationId, siteId, connectorId, limit = 100 } = {}) {
      if (!isResourceId(organizationId) || !isResourceId(siteId) || !isResourceId(connectorId)) {
        throw fail('invalid_telemetry_query');
      }
      const boundedLimit = Number.isInteger(limit) ? Math.max(1, Math.min(100, limit)) : 100;
      const db = await getDatabase();
      const rows = db.prepare(`
        SELECT telemetry_id, organization_id, site_id, connector_id, signed_timestamp,
               event_type, payload_json, received_at, trust_level
        FROM spais_connector_telemetry
        WHERE organization_id = ? AND site_id = ? AND connector_id = ?
        ORDER BY sequence DESC LIMIT ?
      `).all(organizationId, siteId, connectorId, boundedLimit);
      return rows.map(row => ({
        telemetryId: row.telemetry_id,
        organizationId: row.organization_id,
        siteId: row.site_id,
        connectorId: row.connector_id,
        signedAt: row.signed_timestamp,
        eventType: row.event_type,
        payload: JSON.parse(row.payload_json),
        receivedAt: row.received_at,
        trustLevel: row.trust_level,
        interpretation: row.event_type === 'recorder.recording_coverage'
          ? 'reported_not_independently_verified'
          : 'signed_connector_report'
      }));
    },
    async listCoverageReports({ organizationId, siteId, cameraId, windowStart, windowEnd } = {}) {
      if (![organizationId, siteId, cameraId].every(isResourceId) ||
          !Number.isFinite(Date.parse(windowStart)) || !Number.isFinite(Date.parse(windowEnd)) ||
          Date.parse(windowEnd) <= Date.parse(windowStart)) {
        throw fail('invalid_recording_assurance_query');
      }
      const db = await getDatabase();
      const rows = db.prepare(`
        SELECT site_id, connector_id, signed_timestamp, payload_json, received_at, trust_level
        FROM spais_connector_telemetry
        WHERE organization_id = ? AND site_id = ? AND event_type = 'recorder.recording_coverage'
          AND json_extract(payload_json, '$.cameraId') = ?
          AND julianday(json_extract(payload_json, '$.windowEnd')) > julianday(?)
          AND julianday(json_extract(payload_json, '$.windowStart')) < julianday(?)
        ORDER BY sequence ASC
        LIMIT 20001
      `).all(organizationId, siteId, cameraId, windowStart, windowEnd);
      const truncated = rows.length > 20000;
      return {
        truncated,
        reports: rows.slice(0, 20000).map(row => ({
          siteId: row.site_id,
          connectorId: row.connector_id,
          signedAt: row.signed_timestamp,
          payload: JSON.parse(row.payload_json),
          receivedAt: row.received_at,
          trustLevel: row.trust_level
        }))
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
