import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isResourceId } from './contracts.mjs';

const SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);
const SOURCES = new Set(['operator', 'camera_health', 'recording_coverage']);
const STATUSES = new Set(['open', 'acknowledged', 'investigating', 'resolved']);

function fail(code) { return Object.assign(new Error(code), { code }); }
function validText(value, max) { return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max; }

export function validateIncidentInput(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { valid: false, errors: ['body_must_be_object'] };
  const allowed = new Set(['siteId', 'title', 'description', 'severity', 'source', 'sopVersionId']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) errors.push('unsupported_field:' + key);
  if (!isResourceId(input.siteId)) errors.push('site_id_required');
  if (!validText(input.title, 180)) errors.push('title_must_be_1_to_180_characters');
  if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 2000)) errors.push('description_must_be_at_most_2000_characters');
  if (input.severity !== undefined && !SEVERITIES.has(input.severity)) errors.push('invalid_severity');
  if (input.source !== undefined && !SOURCES.has(input.source)) errors.push('invalid_source');
  if (input.sopVersionId !== undefined && !isResourceId(input.sopVersionId)) errors.push('invalid_sop_version_id');
  return { valid: errors.length === 0, errors };
}

export function validateIncidentTransition(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { valid: false, errors: ['body_must_be_object'] };
  for (const key of Object.keys(input)) if (!['status', 'note'].includes(key)) errors.push('unsupported_field:' + key);
  if (!STATUSES.has(input.status)) errors.push('invalid_status');
  if (!validText(input.note, 1000) || input.note.trim().length < 3) errors.push('transition_note_must_be_3_to_1000_characters');
  return { valid: errors.length === 0, errors };
}

/**
 * Single-host SQLite incident lifecycle. Recording-coverage incidents are
 * labelled as reported, never independently verified by the caller's payload.
 */
export function createSqliteIncidentStore(databasePath = process.env.SPAIS_EVENTS_DB_PATH) {
  const path = typeof databasePath === 'string' && databasePath.trim()
    ? (databasePath === ':memory:' ? ':memory:' : resolve(databasePath))
    : null;
  let databasePromise;

  async function getDatabase() {
    if (!path) throw fail('incident_store_not_configured');
    if (!databasePromise) {
      databasePromise = (async () => {
        if (path !== ':memory:') await mkdir(dirname(path), { recursive: true });
        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(path);
        db.exec('PRAGMA foreign_keys = ON;');
        if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
        db.exec("CREATE TABLE IF NOT EXISTS spais_incidents (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, organization_id TEXT NOT NULL, site_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, severity TEXT NOT NULL CHECK (severity IN ('low','medium','high','critical')), source TEXT NOT NULL CHECK (source IN ('operator','camera_health','recording_coverage')), status TEXT NOT NULL CHECK (status IN ('open','acknowledged','investigating','resolved')), evidence_state TEXT NOT NULL CHECK (evidence_state IN ('not_applicable','reported_not_independently_verified')), created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, sop_version_id TEXT, resolved_at TEXT)");
        const incidentColumns = db.prepare('PRAGMA table_info(spais_incidents)').all();
        if (!incidentColumns.some(column => column.name === 'sop_version_id')) db.exec('ALTER TABLE spais_incidents ADD COLUMN sop_version_id TEXT');
        db.exec(`CREATE TABLE IF NOT EXISTS spais_incident_idempotency (organization_id TEXT NOT NULL, site_id TEXT NOT NULL, key_hash TEXT NOT NULL, request_hash TEXT NOT NULL, incident_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (organization_id, site_id, key_hash), FOREIGN KEY (incident_id) REFERENCES spais_incidents(id))`);
        db.exec('CREATE INDEX IF NOT EXISTS idx_spais_incidents_scope ON spais_incidents (organization_id, site_id, sequence DESC)');
        db.exec('CREATE TABLE IF NOT EXISTS spais_audit_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, organization_id TEXT NOT NULL, site_id TEXT, actor_id TEXT NOT NULL, action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, occurred_at TEXT NOT NULL, details_json TEXT NOT NULL)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_spais_audit_org_sequence ON spais_audit_events (organization_id, sequence DESC)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_spais_audit_org_site_sequence ON spais_audit_events (organization_id, site_id, sequence DESC)');
        return db;
      })().catch(error => { databasePromise = undefined; throw error; });
    }
    return databasePromise;
  }

  function toIncident(row) {
    if (!row) return null;
    return {
      contractVersion: 1, id: row.id, organizationId: row.organization_id, siteId: row.site_id,
      title: row.title, description: row.description, severity: row.severity, source: row.source,
      sopVersionId: row.sop_version_id || null,
      status: row.status, evidenceState: row.evidence_state, createdBy: row.created_by,
      createdAt: row.created_at, updatedAt: row.updated_at, resolvedAt: row.resolved_at
    };
  }

  function audit(db, incident, actorId, action, occurredAt, details) {
    db.prepare('INSERT INTO spais_audit_events (event_id, organization_id, site_id, actor_id, action, resource_type, resource_id, occurred_at, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), incident.organizationId, incident.siteId, actorId, action, 'incident', incident.id, occurredAt, JSON.stringify(details));
  }

  return {
    configured: Boolean(path),
    async create({ organizationId, actorId, input, idempotencyKey, now = new Date() }) {
      const validation = validateIncidentInput(input);
      if (!validation.valid) throw Object.assign(fail('invalid_incident'), { validationErrors: validation.errors });
      if (!isResourceId(organizationId) || !isResourceId(actorId)) throw fail('invalid_trusted_scope');
      if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey))) {
        throw fail('invalid_idempotency_key');
      }
      const normalizedInput = {
        siteId: input.siteId,
        title: input.title.trim(),
        description: (input.description || '').trim(),
        severity: input.severity || 'medium',
        source: input.source || 'operator',
        sopVersionId: input.sopVersionId || null
      };
      const requestHash = createHash('sha256').update(JSON.stringify(normalizedInput)).digest('hex');
      const keyHash = idempotencyKey === undefined ? null : createHash('sha256').update(idempotencyKey).digest('hex');
      const db = await getDatabase();
      const timestamp = now.toISOString();
      const incident = {
        contractVersion: 1, id: randomUUID(), organizationId, siteId: input.siteId,
        title: input.title.trim(), description: (input.description || '').trim(),
        severity: input.severity || 'medium', source: input.source || 'operator',
        status: 'open',
        evidenceState: input.source === 'recording_coverage' ? 'reported_not_independently_verified' : 'not_applicable',
        createdBy: actorId, createdAt: timestamp, updatedAt: timestamp, sopVersionId: input.sopVersionId || null, resolvedAt: null
      };
      db.exec('BEGIN IMMEDIATE;');
      try {
        if (keyHash) {
          const existingKey = db.prepare('SELECT request_hash, incident_id FROM spais_incident_idempotency WHERE organization_id = ? AND site_id = ? AND key_hash = ?')
            .get(organizationId, incident.siteId, keyHash);
          if (existingKey) {
            if (existingKey.request_hash !== requestHash) throw fail('idempotency_key_reused_with_different_payload');
            const existingIncident = db.prepare('SELECT * FROM spais_incidents WHERE organization_id = ? AND site_id = ? AND id = ?')
              .get(organizationId, incident.siteId, existingKey.incident_id);
            if (!existingIncident) throw fail('idempotency_record_corrupt');
            db.exec('COMMIT;');
            return { incident: toIncident(existingIncident), replayed: true };
          }
        }
        db.prepare('INSERT INTO spais_incidents (id, organization_id, site_id, title, description, severity, source, status, evidence_state, created_by, created_at, updated_at, sop_version_id, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)')
          .run(incident.id, organizationId, incident.siteId, incident.title, incident.description, incident.severity, incident.source, incident.status, incident.evidenceState, actorId, timestamp, timestamp, incident.sopVersionId);
        audit(db, incident, actorId, 'incident.created', timestamp, { status: incident.status, severity: incident.severity, source: incident.source, evidenceState: incident.evidenceState, sopVersionId: incident.sopVersionId, idempotencyProtected: Boolean(keyHash) });
        if (keyHash) {
          db.prepare('INSERT INTO spais_incident_idempotency (organization_id, site_id, key_hash, request_hash, incident_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(organizationId, incident.siteId, keyHash, requestHash, incident.id, timestamp);
        }
        db.exec('COMMIT;');
      } catch (error) { try { db.exec('ROLLBACK;'); } catch {} throw error; }
      return { incident, replayed: false };
    },
    async get({ organizationId, siteId, incidentId }) {
      if (![organizationId, siteId, incidentId].every(isResourceId)) throw fail('invalid_incident_query');
      const db = await getDatabase();
      return toIncident(db.prepare('SELECT * FROM spais_incidents WHERE organization_id = ? AND site_id = ? AND id = ?').get(organizationId, siteId, incidentId));
    },
    async list({ organizationId, siteId, limit = 100 }) {
      if (![organizationId, siteId].every(isResourceId)) throw fail('invalid_incident_query');
      const db = await getDatabase();
      const bounded = Number.isInteger(limit) ? Math.max(1, Math.min(100, limit)) : 100;
      return db.prepare('SELECT * FROM spais_incidents WHERE organization_id = ? AND site_id = ? ORDER BY sequence DESC LIMIT ?')
        .all(organizationId, siteId, bounded).map(toIncident);
    },
    async transition({ organizationId, siteId, incidentId, actorId, status, note, now = new Date() }) {
      const validation = validateIncidentTransition({ status, note });
      if (!validation.valid) throw Object.assign(fail('invalid_incident_transition'), { validationErrors: validation.errors });
      if (![organizationId, siteId, incidentId, actorId].every(isResourceId)) throw fail('invalid_trusted_scope');
      const db = await getDatabase();
      const timestamp = now.toISOString();
      db.exec('BEGIN IMMEDIATE;');
      try {
        const row = db.prepare('SELECT * FROM spais_incidents WHERE organization_id = ? AND site_id = ? AND id = ?').get(organizationId, siteId, incidentId);
        if (!row) throw fail('incident_not_found');
        const before = toIncident(row);
        const allowed = {
          open: new Set(['acknowledged']),
          acknowledged: new Set(['investigating', 'resolved']),
          investigating: new Set(['resolved']),
          resolved: new Set(['open'])
        };
        if (!allowed[before.status].has(status)) throw fail('invalid_incident_transition');
        const resolvedAt = status === 'resolved' ? timestamp : null;
        db.prepare('UPDATE spais_incidents SET status = ?, updated_at = ?, resolved_at = ? WHERE organization_id = ? AND site_id = ? AND id = ?')
          .run(status, timestamp, resolvedAt, organizationId, siteId, incidentId);
        const after = toIncident(db.prepare('SELECT * FROM spais_incidents WHERE organization_id = ? AND site_id = ? AND id = ?').get(organizationId, siteId, incidentId));
        audit(db, after, actorId, status === 'open' ? 'incident.reopened' : 'incident.' + status, timestamp, { beforeStatus: before.status, afterStatus: status, note: note.trim() });
        db.exec('COMMIT;');
        return after;
      } catch (error) { try { db.exec('ROLLBACK;'); } catch {} throw error; }
    },
    async close() {
      if (!databasePromise) return;
      const db = await databasePromise;
      db.close();
      databasePromise = undefined;
    }
  };
}
