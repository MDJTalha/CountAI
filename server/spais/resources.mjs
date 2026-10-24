import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify as verifySignature } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isResourceId } from './contracts.mjs';

const RESOURCE_TYPES = new Set(['site', 'camera', 'connector']);
const STATUSES = Object.freeze({
  site: new Set(['active', 'inactive']),
  // Camera/connector state is set by verified operations/enrollment, not by inventory CRUD.
  camera: new Set(['pending', 'disabled']),
  connector: new Set(['pending', 'revoked'])
});
const SENSITIVE_KEY = /(password|secret|token|credential|authorization|private.?key|api.?key|stream.?url|rtsp.?url)/i;
const PATCH_KEYS = new Set(['name', 'status', 'metadata']);

function invalid(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function containsSensitiveField(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) =>
    SENSITIVE_KEY.test(key) || containsSensitiveField(item)
  );
}

function normalizeRsaPublicKey(publicKeyJwk) {
  if (!publicKeyJwk || typeof publicKeyJwk !== 'object' || Array.isArray(publicKeyJwk)) {
    throw invalid('invalid_public_key');
  }
  let serialized;
  try { serialized = JSON.stringify(publicKeyJwk); }
  catch { throw invalid('invalid_public_key'); }
  const privateParameters = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'];
  if (Buffer.byteLength(serialized, 'utf8') > 4096 || publicKeyJwk.kty !== 'RSA' ||
      typeof publicKeyJwk.n !== 'string' || typeof publicKeyJwk.e !== 'string' ||
      privateParameters.some(parameter => publicKeyJwk[parameter] !== undefined) ||
      Buffer.from(publicKeyJwk.n, 'base64url').length < 256) {
    throw invalid('invalid_public_key');
  }
  try { createPublicKey({ key: publicKeyJwk, format: 'jwk' }); }
  catch { throw invalid('invalid_public_key'); }
  const normalized = { kty: 'RSA', n: publicKeyJwk.n, e: publicKeyJwk.e };
  const keyThumbprint = createHash('sha256')
    .update(JSON.stringify({ e: normalized.e, kty: normalized.kty, n: normalized.n }))
    .digest('base64url');
  return { publicKeyJwk: normalized, keyThumbprint };
}

function validateMetadata(metadata, errors) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    errors.push('metadata_must_be_object');
    return;
  }
  try {
    if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > 4096) errors.push('metadata_exceeds_4KiB');
    if (containsSensitiveField(metadata)) errors.push('metadata_must_not_contain_credentials_or_stream_urls');
  } catch {
    errors.push('metadata_must_be_json_serializable');
  }
}

export function validateSpaisResourceInput(resourceType, input) {
  const errors = [];
  if (!RESOURCE_TYPES.has(resourceType)) return { valid: false, errors: ['unsupported_resource_type'] };
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, errors: ['body_must_be_object'] };
  }

  const allowedKeys = resourceType === 'site'
    ? new Set(['id', 'name', 'status', 'metadata'])
    : new Set(['id', 'siteId', 'name', 'status', 'metadata']);
  for (const key of Object.keys(input)) {
    if (!allowedKeys.has(key)) errors.push(`unsupported_field:${key}`);
  }
  if (!isResourceId(input.id)) errors.push('id_must_be_valid_resource_identifier');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 160) {
    errors.push('name_must_be_1_to_160_characters');
  }
  const status = input.status ?? (resourceType === 'site' ? 'active' : 'pending');
  if (typeof status !== 'string' || !STATUSES[resourceType].has(status)) errors.push('invalid_status');

  if (resourceType !== 'site' && !isResourceId(input.siteId)) {
    errors.push('siteId_must_be_valid_resource_identifier');
  }
  if (resourceType === 'site' && input.siteId !== undefined) errors.push('site_does_not_accept_siteId');
  if (input.metadata !== undefined) validateMetadata(input.metadata, errors);
  return { valid: errors.length === 0, errors };
}

export function validateSpaisResourcePatch(resourceType, patch) {
  const errors = [];
  if (!RESOURCE_TYPES.has(resourceType)) return { valid: false, errors: ['unsupported_resource_type'] };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { valid: false, errors: ['patch_must_be_object'] };
  }
  const keys = Object.keys(patch);
  if (!keys.length) errors.push('patch_must_not_be_empty');
  for (const key of keys) if (!PATCH_KEYS.has(key)) errors.push(`unsupported_field:${key}`);
  if (patch.name !== undefined &&
      (typeof patch.name !== 'string' || !patch.name.trim() || patch.name.trim().length > 160)) {
    errors.push('name_must_be_1_to_160_characters');
  }
  if (patch.status !== undefined &&
      (typeof patch.status !== 'string' || !STATUSES[resourceType].has(patch.status))) {
    errors.push('invalid_status');
  }
  if (patch.metadata !== undefined) validateMetadata(patch.metadata, errors);
  return { valid: errors.length === 0, errors };
}

/**
 * Tenant-scoped inventory metadata and append-only audit registry backed by
 * the persistent SQLite file shared with operational events. This does not
 * enroll/connect cameras or store camera credentials.
 */
export function createSqliteSpaisResourceStore(databasePath = process.env.SPAIS_EVENTS_DB_PATH) {
  const path = typeof databasePath === 'string' && databasePath.trim()
    ? (databasePath === ':memory:' ? ':memory:' : resolve(databasePath))
    : null;
  let databasePromise;

  async function getDatabase() {
    if (!path) throw invalid('resource_store_not_configured');
    if (!databasePromise) {
      databasePromise = (async () => {
        if (path !== ':memory:') await mkdir(dirname(path), { recursive: true });
        const { DatabaseSync } = await import('node:sqlite');
        const database = new DatabaseSync(path);
        database.exec('PRAGMA foreign_keys = ON;');
        if (path !== ':memory:') database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
        database.exec(`
          CREATE TABLE IF NOT EXISTS spais_resources (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            organization_id TEXT NOT NULL,
            resource_type TEXT NOT NULL CHECK (resource_type IN ('site', 'camera', 'connector')),
            resource_id TEXT NOT NULL,
            site_id TEXT,
            name TEXT NOT NULL,
            status TEXT NOT NULL,
            metadata_json TEXT NOT NULL,
            created_by TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE (organization_id, resource_type, resource_id)
          );
          CREATE INDEX IF NOT EXISTS idx_spais_resources_org_type_sequence
            ON spais_resources (organization_id, resource_type, sequence DESC);
          CREATE INDEX IF NOT EXISTS idx_spais_resources_org_site_type_sequence
            ON spais_resources (organization_id, site_id, resource_type, sequence DESC);
          CREATE TABLE IF NOT EXISTS spais_audit_events (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT NOT NULL UNIQUE,
            organization_id TEXT NOT NULL,
            site_id TEXT,
            actor_id TEXT NOT NULL,
            action TEXT NOT NULL,
            resource_type TEXT NOT NULL,
            resource_id TEXT NOT NULL,
            occurred_at TEXT NOT NULL,
            details_json TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_spais_audit_org_sequence
            ON spais_audit_events (organization_id, sequence DESC);
          CREATE INDEX IF NOT EXISTS idx_spais_audit_org_site_sequence
            ON spais_audit_events (organization_id, site_id, sequence DESC);
          CREATE TABLE IF NOT EXISTS spais_connector_enrollments (
            enrollment_id TEXT PRIMARY KEY,
            organization_id TEXT NOT NULL,
            site_id TEXT NOT NULL,
            connector_id TEXT NOT NULL,
            challenge_hash TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'expired', 'revoked')),
            expires_at TEXT NOT NULL,
            created_by TEXT NOT NULL,
            created_at TEXT NOT NULL,
            completed_at TEXT,
            public_key_jwk TEXT,
            key_thumbprint TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_spais_enrollment_connector
            ON spais_connector_enrollments (organization_id, site_id, connector_id, status);
        `);
        return database;
      })().catch(error => {
        databasePromise = undefined;
        throw error;
      });
    }
    return databasePromise;
  }

  function toResource(row) {
    if (!row) return null;
    return {
      contractVersion: 1,
      resourceType: row.resource_type,
      id: row.resource_id,
      organizationId: row.organization_id,
      siteId: row.site_id,
      name: row.name,
      status: row.status,
      metadata: JSON.parse(row.metadata_json),
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  function writeAudit(database, { organizationId, siteId, actorId, action, resourceType, resourceId, occurredAt, details }) {
    database.prepare(`
      INSERT INTO spais_audit_events
        (event_id, organization_id, site_id, actor_id, action, resource_type, resource_id, occurred_at, details_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), organizationId, siteId ?? null, actorId, action,
      resourceType, resourceId, occurredAt, JSON.stringify(details)
    );
  }

  function mapUniqueError(error) {
    if (error.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/.test(error.message)) {
      return invalid('resource_already_exists');
    }
    return error;
  }

  return {
    configured: Boolean(path),
    async create({ organizationId, actorId, resourceType, input, now = new Date() }) {
      if (!RESOURCE_TYPES.has(resourceType)) throw invalid('unsupported_resource_type');
      const validation = validateSpaisResourceInput(resourceType, input);
      if (!validation.valid) throw Object.assign(invalid('invalid_resource', 'Resource validation failed'), { validationErrors: validation.errors });
      if (!isResourceId(organizationId) || !isResourceId(actorId)) throw invalid('invalid_trusted_scope');
      const database = await getDatabase();
      const timestamp = now.toISOString();
      const status = input.status ?? (resourceType === 'site' ? 'active' : 'pending');
      database.exec('BEGIN IMMEDIATE;');
      try {
        if (resourceType !== 'site') {
          const site = database.prepare(`
            SELECT resource_id FROM spais_resources
            WHERE organization_id = ? AND resource_type = 'site' AND resource_id = ?
          `).get(organizationId, input.siteId);
          if (!site) throw invalid('site_not_found');
        }
        database.prepare(`
          INSERT INTO spais_resources
            (organization_id, resource_type, resource_id, site_id, name, status, metadata_json, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          organizationId, resourceType, input.id, resourceType === 'site' ? null : input.siteId,
          input.name.trim(), status, JSON.stringify(input.metadata ?? {}), actorId, timestamp, timestamp
        );
        const row = database.prepare(`
          SELECT * FROM spais_resources
          WHERE organization_id = ? AND resource_type = ? AND resource_id = ?
        `).get(organizationId, resourceType, input.id);
        const resource = toResource(row);
        writeAudit(database, {
          organizationId, siteId: resource.siteId, actorId, action: 'resource.created',
          resourceType, resourceId: resource.id, occurredAt: timestamp, details: { after: resource }
        });
        database.exec('COMMIT;');
        return resource;
      } catch (error) {
        try { database.exec('ROLLBACK;'); } catch {}
        throw mapUniqueError(error);
      }
    },
    async get({ organizationId, resourceType, resourceId, siteId } = {}) {
      if (!isResourceId(organizationId) || !RESOURCE_TYPES.has(resourceType) || !isResourceId(resourceId)) {
        throw invalid('invalid_resource_query');
      }
      const database = await getDatabase();
      const row = siteId
        ? database.prepare(`
            SELECT * FROM spais_resources
            WHERE organization_id = ? AND resource_type = ? AND resource_id = ? AND site_id = ?
          `).get(organizationId, resourceType, resourceId, siteId)
        : database.prepare(`
            SELECT * FROM spais_resources
            WHERE organization_id = ? AND resource_type = ? AND resource_id = ?
          `).get(organizationId, resourceType, resourceId);
      return toResource(row);
    },
    async update({ organizationId, actorId, resourceType, resourceId, siteId, patch, now = new Date() }) {
      if (!RESOURCE_TYPES.has(resourceType) || !isResourceId(organizationId) ||
          !isResourceId(actorId) || !isResourceId(resourceId)) throw invalid('invalid_trusted_scope');
      const validation = validateSpaisResourcePatch(resourceType, patch);
      if (!validation.valid) throw Object.assign(invalid('invalid_resource_patch'), { validationErrors: validation.errors });
      const database = await getDatabase();
      const timestamp = now.toISOString();
      database.exec('BEGIN IMMEDIATE;');
      try {
        const existing = siteId
          ? database.prepare(`
              SELECT * FROM spais_resources
              WHERE organization_id = ? AND resource_type = ? AND resource_id = ? AND site_id = ?
            `).get(organizationId, resourceType, resourceId, siteId)
          : database.prepare(`
              SELECT * FROM spais_resources
              WHERE organization_id = ? AND resource_type = ? AND resource_id = ?
            `).get(organizationId, resourceType, resourceId);
        if (!existing) throw invalid('resource_not_found');
        const before = toResource(existing);
        const nextName = patch.name === undefined ? before.name : patch.name.trim();
        const nextStatus = patch.status === undefined ? before.status : patch.status;
        const nextMetadata = patch.metadata === undefined ? before.metadata : patch.metadata;
        database.prepare(`
          UPDATE spais_resources SET name = ?, status = ?, metadata_json = ?, updated_at = ?
          WHERE organization_id = ? AND resource_type = ? AND resource_id = ?
        `).run(nextName, nextStatus, JSON.stringify(nextMetadata), timestamp, organizationId, resourceType, resourceId);
        let revokedEnrollmentCount = 0;
        if (resourceType === 'connector' && nextStatus === 'revoked') {
          const revoked = database.prepare(`
            UPDATE spais_connector_enrollments SET status = 'revoked'
            WHERE organization_id = ? AND site_id = ? AND connector_id = ?
              AND status IN ('pending', 'completed')
          `).run(organizationId, before.siteId, resourceId);
          revokedEnrollmentCount = revoked.changes;
        }
        const updated = database.prepare(`
          SELECT * FROM spais_resources
          WHERE organization_id = ? AND resource_type = ? AND resource_id = ?
        `).get(organizationId, resourceType, resourceId);
        const after = toResource(updated);
        writeAudit(database, {
          organizationId, siteId: after.siteId, actorId,
          action: resourceType === 'connector' && nextStatus === 'revoked' ? 'connector.key_revoked' : 'resource.updated',
          resourceType, resourceId, occurredAt: timestamp,
          details: { before, after, ...(revokedEnrollmentCount ? { revokedEnrollmentCount } : {}) }
        });
        database.exec('COMMIT;');
        return after;
      } catch (error) {
        try { database.exec('ROLLBACK;'); } catch {}
        throw error;
      }
    },
    async list({ organizationId, resourceType, siteId, resourceIds, limit = 100 } = {}) {
      if (!isResourceId(organizationId) || !RESOURCE_TYPES.has(resourceType)) throw invalid('invalid_resource_query');
      if (resourceIds !== undefined && (!Array.isArray(resourceIds) || resourceIds.some(id => !isResourceId(id)))) {
        throw invalid('invalid_resource_query');
      }
      if (resourceIds !== undefined && resourceIds.length === 0) return [];
      const database = await getDatabase();
      const boundedLimit = Number.isInteger(limit) ? Math.max(1, Math.min(100, limit)) : 100;
      let rows;
      if (resourceIds !== undefined) {
        const placeholders = resourceIds.map(() => '?').join(', ');
        rows = database.prepare(`
          SELECT * FROM spais_resources
          WHERE organization_id = ? AND resource_type = ? AND resource_id IN (${placeholders})
          ORDER BY sequence DESC LIMIT ?
        `).all(organizationId, resourceType, ...resourceIds, boundedLimit);
      } else if (siteId) {
        rows = database.prepare(`
          SELECT * FROM spais_resources
          WHERE organization_id = ? AND resource_type = ? AND site_id = ?
          ORDER BY sequence DESC LIMIT ?
        `).all(organizationId, resourceType, siteId, boundedLimit);
      } else {
        rows = database.prepare(`
          SELECT * FROM spais_resources
          WHERE organization_id = ? AND resource_type = ?
          ORDER BY sequence DESC LIMIT ?
        `).all(organizationId, resourceType, boundedLimit);
      }
      return rows.map(toResource);
    },
    async listAudit({ organizationId, siteId, limit = 100 } = {}) {
      if (!isResourceId(organizationId)) throw invalid('invalid_audit_query');
      const database = await getDatabase();
      const boundedLimit = Number.isInteger(limit) ? Math.max(1, Math.min(100, limit)) : 100;
      const rows = siteId
        ? database.prepare(`
            SELECT * FROM spais_audit_events
            WHERE organization_id = ? AND site_id = ?
            ORDER BY sequence DESC LIMIT ?
          `).all(organizationId, siteId, boundedLimit)
        : database.prepare(`
            SELECT * FROM spais_audit_events
            WHERE organization_id = ?
            ORDER BY sequence DESC LIMIT ?
          `).all(organizationId, boundedLimit);
      return rows.map(row => ({
        id: row.event_id,
        organizationId: row.organization_id,
        siteId: row.site_id,
        actorId: row.actor_id,
        action: row.action,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        occurredAt: row.occurred_at,
        details: JSON.parse(row.details_json)
      }));
    },
    async createConnectorEnrollmentChallenge({ organizationId, siteId, connectorId, actorId, publicKeyJwk, now = new Date(), ttlSeconds = 600 }) {
      if (!isResourceId(organizationId) || !isResourceId(siteId) ||
          !isResourceId(connectorId) || !isResourceId(actorId)) throw invalid('invalid_trusted_scope');
      const normalizedKey = normalizeRsaPublicKey(publicKeyJwk);
      const database = await getDatabase();
      const enrollmentId = randomUUID();
      const challenge = randomBytes(32).toString('base64url');
      const challengeHash = createHash('sha256').update(challenge).digest('hex');
      const createdAt = now.toISOString();
      const expiresAt = new Date(now.getTime() + Math.max(60, Math.min(900, ttlSeconds)) * 1000).toISOString();
      database.exec('BEGIN IMMEDIATE;');
      try {
        const connector = database.prepare(`
          SELECT * FROM spais_resources
          WHERE organization_id = ? AND resource_type = 'connector' AND resource_id = ? AND site_id = ?
        `).get(organizationId, connectorId, siteId);
        if (!connector || !['pending', 'enrolled'].includes(connector.status)) throw invalid('connector_not_enrollable');
        const superseded = database.prepare(`
          UPDATE spais_connector_enrollments SET status = 'revoked'
          WHERE organization_id = ? AND site_id = ? AND connector_id = ? AND status = 'pending'
        `).run(organizationId, siteId, connectorId);
        if (superseded.changes > 0) {
          writeAudit(database, {
            organizationId, siteId, actorId, action: 'connector.enrollment_challenge_superseded',
            resourceType: 'connector', resourceId: connectorId, occurredAt: createdAt,
            details: { supersededCount: superseded.changes }
          });
        }
        database.prepare(`
          INSERT INTO spais_connector_enrollments
            (enrollment_id, organization_id, site_id, connector_id, challenge_hash, status, expires_at, created_by, created_at, public_key_jwk, key_thumbprint)
          VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)
        `).run(
          enrollmentId, organizationId, siteId, connectorId, challengeHash, expiresAt, actorId, createdAt,
          JSON.stringify(normalizedKey.publicKeyJwk), normalizedKey.keyThumbprint
        );
        writeAudit(database, {
          organizationId, siteId, actorId, action: 'connector.enrollment_challenge_created',
          resourceType: 'connector', resourceId: connectorId, occurredAt: createdAt,
          details: { enrollmentId, expiresAt, keyThumbprint: normalizedKey.keyThumbprint }
        });
        database.exec('COMMIT;');
      } catch (error) {
        try { database.exec('ROLLBACK;'); } catch {}
        throw error;
      }
      // The raw challenge is returned once; its hash and the expected public key are persisted.
      return { enrollmentId, challenge, connectorId, siteId, expiresAt, keyThumbprint: normalizedKey.keyThumbprint };
    },
    async completeConnectorEnrollment({ enrollmentId, challenge, signature, now = new Date() }) {
      if (!isResourceId(enrollmentId) || typeof challenge !== 'string' ||
          !/^[A-Za-z0-9_-]{40,64}$/.test(challenge) ||
          typeof signature !== 'string' || signature.length > 2048) {
        throw invalid('invalid_enrollment_proof');
      }
      const database = await getDatabase();
      let expired = false;
      let result;
      database.exec('BEGIN IMMEDIATE;');
      try {
        const enrollment = database.prepare(`
          SELECT * FROM spais_connector_enrollments WHERE enrollment_id = ?
        `).get(enrollmentId);
        if (!enrollment) throw invalid('enrollment_not_found');
        if (enrollment.status !== 'pending') throw invalid('enrollment_not_pending');
        if (Date.parse(enrollment.expires_at) <= now.getTime()) {
          database.prepare(`
            UPDATE spais_connector_enrollments SET status = 'expired' WHERE enrollment_id = ?
          `).run(enrollmentId);
          writeAudit(database, {
            organizationId: enrollment.organization_id, siteId: enrollment.site_id,
            actorId: enrollment.created_by, action: 'connector.enrollment_expired',
            resourceType: 'connector', resourceId: enrollment.connector_id,
            occurredAt: now.toISOString(), details: { enrollmentId }
          });
          database.exec('COMMIT;');
          expired = true;
        } else {
          const suppliedHash = createHash('sha256').update(challenge).digest();
          const storedHash = Buffer.from(enrollment.challenge_hash, 'hex');
          if (storedHash.length !== suppliedHash.length || !timingSafeEqual(storedHash, suppliedHash)) {
            throw invalid('invalid_enrollment_proof');
          }
          let publicKey;
          try {
            publicKey = createPublicKey({ key: JSON.parse(enrollment.public_key_jwk), format: 'jwk' });
          } catch {
            throw invalid('invalid_public_key');
          }
          const validSignature = verifySignature(
            'RSA-SHA256',
            Buffer.from(enrollmentId + '.' + challenge),
            publicKey,
            Buffer.from(signature, 'base64url')
          );
          if (!validSignature) throw invalid('invalid_enrollment_proof');

          const connector = database.prepare(`
            SELECT * FROM spais_resources
            WHERE organization_id = ? AND resource_type = 'connector' AND resource_id = ? AND site_id = ?
          `).get(enrollment.organization_id, enrollment.connector_id, enrollment.site_id);
          if (!connector || !['pending', 'enrolled'].includes(connector.status)) throw invalid('connector_not_enrollable');

          const priorActiveEnrollments = database.prepare(`
            SELECT key_thumbprint FROM spais_connector_enrollments
            WHERE organization_id = ? AND site_id = ? AND connector_id = ? AND status = 'completed'
          `).all(enrollment.organization_id, enrollment.site_id, enrollment.connector_id);
          const keyThumbprint = enrollment.key_thumbprint;
          const completedAt = now.toISOString();
          // Rotation is atomic: the prior key is revoked in the same transaction that
          // activates the replacement, so two keys cannot remain trusted after commit.
          if (priorActiveEnrollments.length) {
            database.prepare(`
              UPDATE spais_connector_enrollments SET status = 'revoked'
              WHERE organization_id = ? AND site_id = ? AND connector_id = ? AND status = 'completed'
            `).run(enrollment.organization_id, enrollment.site_id, enrollment.connector_id);
          }
          database.prepare(`
            UPDATE spais_connector_enrollments SET status = 'completed', completed_at = ?
            WHERE enrollment_id = ?
          `).run(completedAt, enrollmentId);
          database.prepare(`
            UPDATE spais_resources SET status = 'enrolled', updated_at = ?
            WHERE organization_id = ? AND resource_type = 'connector' AND resource_id = ? AND site_id = ?
          `).run(completedAt, enrollment.organization_id, enrollment.connector_id, enrollment.site_id);
          const updatedRow = database.prepare(`
            SELECT * FROM spais_resources
            WHERE organization_id = ? AND resource_type = 'connector' AND resource_id = ?
          `).get(enrollment.organization_id, enrollment.connector_id);
          const resource = toResource(updatedRow);
          writeAudit(database, {
            organizationId: enrollment.organization_id, siteId: enrollment.site_id,
            actorId: enrollment.created_by,
            action: priorActiveEnrollments.length ? 'connector.key_rotated' : 'connector.enrollment_completed',
            resourceType: 'connector', resourceId: enrollment.connector_id,
            occurredAt: completedAt,
            details: {
              enrollmentId, keyThumbprint, after: resource,
              ...(priorActiveEnrollments.length
                ? { previousKeyThumbprints: priorActiveEnrollments.map(item => item.key_thumbprint) }
                : {})
            }
          });
          database.exec('COMMIT;');
          result = { enrollmentId, connector: resource, keyThumbprint, enrolledAt: completedAt };
        }
      } catch (error) {
        try { database.exec('ROLLBACK;'); } catch {}
        throw error;
      }
      if (expired) throw invalid('enrollment_expired');
      return result;
    },
    async getConnectorIdentity({ organizationId, siteId, connectorId } = {}) {
      if (!isResourceId(organizationId) || !isResourceId(siteId) || !isResourceId(connectorId)) {
        throw invalid('invalid_resource_query');
      }
      const database = await getDatabase();
      const row = database.prepare(`
        SELECT e.public_key_jwk, e.key_thumbprint, e.completed_at
        FROM spais_connector_enrollments e
        JOIN spais_resources r
          ON r.organization_id = e.organization_id
         AND r.resource_type = 'connector'
         AND r.resource_id = e.connector_id
         AND r.site_id = e.site_id
        WHERE e.organization_id = ? AND e.site_id = ? AND e.connector_id = ?
          AND e.status = 'completed' AND r.status = 'enrolled'
        ORDER BY e.completed_at DESC LIMIT 1
      `).get(organizationId, siteId, connectorId);
      if (!row) return null;
      return {
        publicKeyJwk: JSON.parse(row.public_key_jwk),
        keyThumbprint: row.key_thumbprint,
        enrolledAt: row.completed_at
      };
    },
    async close() {
      if (!databasePromise) return;
      const database = await databasePromise;
      database.close();
      databasePromise = undefined;
    }
  };
}
