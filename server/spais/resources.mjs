import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isResourceId } from './contracts.mjs';

const RESOURCE_TYPES = new Set(['site', 'camera', 'connector']);
const STATUSES = Object.freeze({
  site: new Set(['active', 'inactive']),
  camera: new Set(['pending', 'active', 'disabled']),
  connector: new Set(['pending', 'active', 'revoked'])
});
const SENSITIVE_KEY = /(password|secret|token|credential|authorization|private.?key|api.?key|stream.?url|rtsp.?url)/i;

function invalid(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function containsSensitiveField(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) =>
    SENSITIVE_KEY.test(key) || containsSensitiveField(item)
  );
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

  if (input.metadata !== undefined) {
    if (!input.metadata || typeof input.metadata !== 'object' || Array.isArray(input.metadata)) {
      errors.push('metadata_must_be_object');
    } else {
      try {
        if (Buffer.byteLength(JSON.stringify(input.metadata), 'utf8') > 4096) errors.push('metadata_exceeds_4KiB');
        if (containsSensitiveField(input.metadata)) errors.push('metadata_must_not_contain_credentials_or_stream_urls');
      } catch {
        errors.push('metadata_must_be_json_serializable');
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Tenant-scoped metadata registry backed by the same persistent SQLite file
 * used by the operational event store. This stores inventory metadata only;
 * it does not enroll or connect to cameras and never stores camera credentials.
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
      try {
        database.prepare(`
          INSERT INTO spais_resources
            (organization_id, resource_type, resource_id, site_id, name, status, metadata_json, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          organizationId,
          resourceType,
          input.id,
          resourceType === 'site' ? null : input.siteId,
          input.name.trim(),
          status,
          JSON.stringify(input.metadata ?? {}),
          actorId,
          timestamp,
          timestamp
        );
      } catch (error) {
        if (error.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/.test(error.message)) {
          throw invalid('resource_already_exists');
        }
        throw error;
      }
      const row = database.prepare(`
        SELECT * FROM spais_resources
        WHERE organization_id = ? AND resource_type = ? AND resource_id = ?
      `).get(organizationId, resourceType, input.id);
      return toResource(row);
    },
    async list({ organizationId, resourceType, siteId, limit = 100 } = {}) {
      if (!isResourceId(organizationId) || !RESOURCE_TYPES.has(resourceType)) throw invalid('invalid_resource_query');
      const database = await getDatabase();
      const boundedLimit = Number.isInteger(limit) ? Math.max(1, Math.min(100, limit)) : 100;
      const rows = siteId
        ? database.prepare(`
            SELECT * FROM spais_resources
            WHERE organization_id = ? AND resource_type = ? AND site_id = ?
            ORDER BY sequence DESC LIMIT ?
          `).all(organizationId, resourceType, siteId, boundedLimit)
        : database.prepare(`
            SELECT * FROM spais_resources
            WHERE organization_id = ? AND resource_type = ?
            ORDER BY sequence DESC LIMIT ?
          `).all(organizationId, resourceType, boundedLimit);
      return rows.map(toResource);
    },
    async close() {
      if (!databasePromise) return;
      const database = await databasePromise;
      database.close();
      databasePromise = undefined;
    }
  };
}
