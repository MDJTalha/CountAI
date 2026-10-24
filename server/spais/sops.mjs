import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isResourceId } from './contracts.mjs';

const STATUSES = new Set(['draft', 'in_review', 'approved', 'retired']);
const CATEGORIES = new Set(['safety', 'security', 'operations', 'recording_assurance', 'privacy', 'other']);

function fail(code) { return Object.assign(new Error(code), { code }); }
function validText(value, max) { return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max; }

export function validateSopInput(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { valid: false, errors: ['body_must_be_object'] };
  const allowed = new Set(['siteId', 'policyId', 'title', 'content', 'category']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) errors.push('unsupported_field:' + key);
  if (!isResourceId(input.siteId)) errors.push('site_id_required');
  if (!isResourceId(input.policyId)) errors.push('policy_id_required');
  if (!validText(input.title, 180)) errors.push('title_must_be_1_to_180_characters');
  if (!validText(input.content, 12000)) errors.push('content_must_be_1_to_12000_characters');
  if (input.category !== undefined && !CATEGORIES.has(input.category)) errors.push('invalid_category');
  return { valid: errors.length === 0, errors };
}

export function validateSopTransition(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { valid: false, errors: ['body_must_be_object'] };
  for (const key of Object.keys(input)) if (!['status', 'note'].includes(key)) errors.push('unsupported_field:' + key);
  if (!STATUSES.has(input.status)) errors.push('invalid_status');
  if (!validText(input.note, 1000) || input.note.trim().length < 3) errors.push('transition_note_must_be_3_to_1000_characters');
  return { valid: errors.length === 0, errors };
}

/**
 * Versioned SOP/policy registry. Every version starts as a draft; approved
 * versions are immutable and approval must be performed by a different actor
 * from the version creator. Intended for single-host SQLite deployments.
 */
export function createSqliteSopStore(databasePath = process.env.SPAIS_EVENTS_DB_PATH) {
  const path = typeof databasePath === 'string' && databasePath.trim()
    ? (databasePath === ':memory:' ? ':memory:' : resolve(databasePath))
    : null;
  let databasePromise;

  async function getDatabase() {
    if (!path) throw fail('sop_store_not_configured');
    if (!databasePromise) {
      databasePromise = (async () => {
        if (path !== ':memory:') await mkdir(dirname(path), { recursive: true });
        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(path);
        db.exec('PRAGMA foreign_keys = ON;');
        if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
        db.exec(`
          CREATE TABLE IF NOT EXISTS spais_sop_versions (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            id TEXT NOT NULL UNIQUE,
            organization_id TEXT NOT NULL,
            site_id TEXT NOT NULL,
            policy_id TEXT NOT NULL,
            version INTEGER NOT NULL CHECK (version > 0),
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            category TEXT NOT NULL CHECK (category IN ('safety','security','operations','recording_assurance','privacy','other')),
            status TEXT NOT NULL CHECK (status IN ('draft','in_review','approved','retired')),
            created_by TEXT NOT NULL,
            approved_by TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            approved_at TEXT,
            UNIQUE (organization_id, site_id, policy_id, version)
          );
          CREATE INDEX IF NOT EXISTS idx_spais_sops_scope
            ON spais_sop_versions (organization_id, site_id, sequence DESC);
          CREATE INDEX IF NOT EXISTS idx_spais_sops_policy_version
            ON spais_sop_versions (organization_id, site_id, policy_id, version DESC);
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
        `);
        return db;
      })().catch(error => { databasePromise = undefined; throw error; });
    }
    return databasePromise;
  }

  function toSop(row) {
    if (!row) return null;
    return {
      contractVersion: 1, resourceType: 'sop_version', id: row.id,
      organizationId: row.organization_id, siteId: row.site_id,
      policyId: row.policy_id, version: row.version, title: row.title,
      content: row.content, category: row.category, status: row.status,
      createdBy: row.created_by, approvedBy: row.approved_by,
      createdAt: row.created_at, updatedAt: row.updated_at, approvedAt: row.approved_at
    };
  }

  function audit(db, sop, actorId, action, occurredAt, details) {
    db.prepare(`INSERT INTO spais_audit_events
      (event_id, organization_id, site_id, actor_id, action, resource_type, resource_id, occurred_at, details_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), sop.organizationId, sop.siteId, actorId, action, 'sop_version', sop.id, occurredAt, JSON.stringify(details));
  }

  return {
    configured: Boolean(path),
    async create({ organizationId, actorId, input, now = new Date() }) {
      const validation = validateSopInput(input);
      if (!validation.valid) throw Object.assign(fail('invalid_sop'), { validationErrors: validation.errors });
      if (!isResourceId(organizationId) || !isResourceId(actorId)) throw fail('invalid_trusted_scope');
      const db = await getDatabase();
      const timestamp = now.toISOString();
      db.exec('BEGIN IMMEDIATE;');
      try {
        const latest = db.prepare('SELECT MAX(version) AS version FROM spais_sop_versions WHERE organization_id = ? AND site_id = ? AND policy_id = ?')
          .get(organizationId, input.siteId, input.policyId);
        const version = (latest?.version || 0) + 1;
        const sop = {
          contractVersion: 1, resourceType: 'sop_version', id: randomUUID(),
          organizationId, siteId: input.siteId, policyId: input.policyId, version,
          title: input.title.trim(), content: input.content.trim(), category: input.category || 'operations',
          status: 'draft', createdBy: actorId, approvedBy: null,
          createdAt: timestamp, updatedAt: timestamp, approvedAt: null
        };
        db.prepare(`INSERT INTO spais_sop_versions
          (id, organization_id, site_id, policy_id, version, title, content, category, status, created_by, approved_by, created_at, updated_at, approved_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)`)
          .run(sop.id, organizationId, sop.siteId, sop.policyId, version, sop.title, sop.content, sop.category, sop.status, actorId, timestamp, timestamp);
        audit(db, sop, actorId, 'sop.version_created', timestamp, { policyId: sop.policyId, version, status: 'draft' });
        db.exec('COMMIT;');
        return sop;
      } catch (error) {
        try { db.exec('ROLLBACK;'); } catch {}
        throw error;
      }
    },
    async get({ organizationId, siteId, sopId }) {
      if (![organizationId, siteId, sopId].every(isResourceId)) throw fail('invalid_sop_query');
      const db = await getDatabase();
      return toSop(db.prepare('SELECT * FROM spais_sop_versions WHERE organization_id = ? AND site_id = ? AND id = ?')
        .get(organizationId, siteId, sopId));
    },
    async list({ organizationId, siteId, limit = 100 }) {
      if (![organizationId, siteId].every(isResourceId)) throw fail('invalid_sop_query');
      const db = await getDatabase();
      const bounded = Number.isInteger(limit) ? Math.max(1, Math.min(100, limit)) : 100;
      return db.prepare('SELECT * FROM spais_sop_versions WHERE organization_id = ? AND site_id = ? ORDER BY sequence DESC LIMIT ?')
        .all(organizationId, siteId, bounded).map(toSop);
    },
    async transition({ organizationId, siteId, sopId, actorId, status, note, now = new Date() }) {
      const validation = validateSopTransition({ status, note });
      if (!validation.valid) throw Object.assign(fail('invalid_sop_transition'), { validationErrors: validation.errors });
      if (![organizationId, siteId, sopId, actorId].every(isResourceId)) throw fail('invalid_trusted_scope');
      const db = await getDatabase();
      const timestamp = now.toISOString();
      db.exec('BEGIN IMMEDIATE;');
      try {
        const row = db.prepare('SELECT * FROM spais_sop_versions WHERE organization_id = ? AND site_id = ? AND id = ?')
          .get(organizationId, siteId, sopId);
        if (!row) throw fail('sop_not_found');
        const before = toSop(row);
        const allowed = {
          draft: new Set(['in_review']),
          in_review: new Set(['draft', 'approved']),
          approved: new Set(['retired']),
          retired: new Set()
        };
        if (!allowed[before.status].has(status)) throw fail('invalid_sop_transition');
        if (status === 'approved' && before.createdBy === actorId) throw fail('sop_self_approval_denied');
        const approvedBy = status === 'approved' ? actorId : before.approvedBy;
        const approvedAt = status === 'approved' ? timestamp : before.approvedAt;
        db.prepare('UPDATE spais_sop_versions SET status = ?, updated_at = ?, approved_by = ?, approved_at = ? WHERE organization_id = ? AND site_id = ? AND id = ?')
          .run(status, timestamp, approvedBy, approvedAt, organizationId, siteId, sopId);
        const after = toSop(db.prepare('SELECT * FROM spais_sop_versions WHERE organization_id = ? AND site_id = ? AND id = ?')
          .get(organizationId, siteId, sopId));
        audit(db, after, actorId, status === 'approved' ? 'sop.version_approved' : status === 'retired' ? 'sop.version_retired' : 'sop.status_changed',
          timestamp, { beforeStatus: before.status, afterStatus: status, note: note.trim(), version: after.version });
        db.exec('COMMIT;');
        return after;
      } catch (error) {
        try { db.exec('ROLLBACK;'); } catch {}
        throw error;
      }
    },
    async close() {
      if (!databasePromise) return;
      const db = await databasePromise;
      db.close();
      databasePromise = undefined;
    }
  };
}
