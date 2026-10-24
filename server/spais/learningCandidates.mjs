import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isResourceId } from './contracts.mjs';

const CHANGE_TYPES = new Set(['model_weights', 'thresholds', 'preprocessing', 'rule_set']);
const STATUSES = new Set(['proposed', 'under_review', 'evaluation_pending', 'rejected']);
const SHA256 = /^[a-f0-9]{64}$/i;

function fail(code) { return Object.assign(new Error(code), { code }); }
function validText(value, max) { return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max; }

export function validateLearningCandidateInput(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { valid: false, errors: ['body_must_be_object'] };
  const allowed = new Set([
    'siteId', 'title', 'rationale', 'baselineVersion', 'proposedVersion', 'changeType',
    'artifactSha256', 'evaluationDatasetSha256', 'evaluationPlan'
  ]);
  for (const key of Object.keys(input)) if (!allowed.has(key)) errors.push('unsupported_field:' + key);
  if (!isResourceId(input.siteId)) errors.push('site_id_required');
  if (!validText(input.title, 180)) errors.push('title_must_be_1_to_180_characters');
  if (!validText(input.rationale, 2000)) errors.push('rationale_must_be_1_to_2000_characters');
  if (!validText(input.baselineVersion, 64)) errors.push('baseline_version_must_be_1_to_64_characters');
  if (!validText(input.proposedVersion, 64)) errors.push('proposed_version_must_be_1_to_64_characters');
  if (!CHANGE_TYPES.has(input.changeType)) errors.push('invalid_change_type');
  if (typeof input.artifactSha256 !== 'string' || !SHA256.test(input.artifactSha256)) errors.push('invalid_artifact_sha256');
  if (typeof input.evaluationDatasetSha256 !== 'string' || !SHA256.test(input.evaluationDatasetSha256)) errors.push('invalid_evaluation_dataset_sha256');
  if (!Array.isArray(input.evaluationPlan) || input.evaluationPlan.length < 1 || input.evaluationPlan.length > 12 ||
      input.evaluationPlan.some(item => !validText(item, 240))) {
    errors.push('evaluation_plan_must_contain_1_to_12_bounded_steps');
  }
  return { valid: errors.length === 0, errors };
}

export function validateLearningCandidateTransition(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { valid: false, errors: ['body_must_be_object'] };
  for (const key of Object.keys(input)) if (!['status', 'note'].includes(key)) errors.push('unsupported_field:' + key);
  if (!STATUSES.has(input.status) || input.status === 'proposed') errors.push('invalid_learning_candidate_status');
  if (!validText(input.note, 1000) || input.note.trim().length < 3) errors.push('transition_note_must_be_3_to_1000_characters');
  return { valid: errors.length === 0, errors };
}

/**
 * Metadata-only, single-host registry for proposed learning changes. This is
 * not an evaluator and deliberately exposes no production model-promotion state.
 */
export function createSqliteLearningCandidateStore(databasePath = process.env.SPAIS_EVENTS_DB_PATH) {
  const path = typeof databasePath === 'string' && databasePath.trim()
    ? (databasePath === ':memory:' ? ':memory:' : resolve(databasePath))
    : null;
  let databasePromise;

  async function getDatabase() {
    if (!path) throw fail('learning_candidate_store_not_configured');
    if (!databasePromise) {
      databasePromise = (async () => {
        if (path !== ':memory:') await mkdir(dirname(path), { recursive: true });
        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(path);
        db.exec('PRAGMA foreign_keys = ON;');
        if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
        db.exec(`
          CREATE TABLE IF NOT EXISTS spais_model_candidates (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            id TEXT NOT NULL UNIQUE,
            organization_id TEXT NOT NULL,
            site_id TEXT NOT NULL,
            title TEXT NOT NULL,
            rationale TEXT NOT NULL,
            baseline_version TEXT NOT NULL,
            proposed_version TEXT NOT NULL,
            change_type TEXT NOT NULL CHECK (change_type IN ('model_weights','thresholds','preprocessing','rule_set')),
            artifact_sha256 TEXT NOT NULL,
            evaluation_dataset_sha256 TEXT NOT NULL,
            evaluation_plan_json TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('proposed','under_review','evaluation_pending','rejected')),
            created_by TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_note TEXT,
            evaluation_status TEXT NOT NULL DEFAULT 'not_run',
            latest_evaluation_id TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_spais_model_candidates_scope
            ON spais_model_candidates (organization_id, site_id, sequence DESC);
          CREATE TABLE IF NOT EXISTS spais_model_evaluations (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            id TEXT NOT NULL UNIQUE,
            organization_id TEXT NOT NULL,
            site_id TEXT NOT NULL,
            candidate_id TEXT NOT NULL,
            run_id TEXT NOT NULL,
            nonce TEXT NOT NULL,
            artifact_sha256 TEXT NOT NULL,
            evaluation_dataset_sha256 TEXT NOT NULL,
            evaluator_version TEXT NOT NULL,
            evaluator_key_id TEXT NOT NULL,
            evaluated_at TEXT NOT NULL,
            received_at TEXT NOT NULL,
            sample_count INTEGER NOT NULL,
            precision REAL NOT NULL,
            recall REAL NOT NULL,
            false_positive_rate REAL NOT NULL,
            result TEXT NOT NULL CHECK (result IN ('passed','failed')),
            thresholds_json TEXT NOT NULL,
            attestation_sha256 TEXT NOT NULL,
            UNIQUE (organization_id, site_id, run_id),
            UNIQUE (organization_id, site_id, nonce)
          );
          CREATE INDEX IF NOT EXISTS idx_spais_model_evaluations_candidate
            ON spais_model_evaluations (organization_id, site_id, candidate_id, sequence DESC);
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
          CREATE INDEX IF NOT EXISTS idx_spais_audit_org_sequence ON spais_audit_events (organization_id, sequence DESC);
          CREATE INDEX IF NOT EXISTS idx_spais_audit_org_site_sequence ON spais_audit_events (organization_id, site_id, sequence DESC);
        `);
        const candidateColumns = db.prepare('PRAGMA table_info(spais_model_candidates)').all();
        if (!candidateColumns.some(column => column.name === 'evaluation_status')) db.exec("ALTER TABLE spais_model_candidates ADD COLUMN evaluation_status TEXT NOT NULL DEFAULT 'not_run'");
        if (!candidateColumns.some(column => column.name === 'latest_evaluation_id')) db.exec('ALTER TABLE spais_model_candidates ADD COLUMN latest_evaluation_id TEXT');
        return db;
      })().catch(error => { databasePromise = undefined; throw error; });
    }
    return databasePromise;
  }

  function toCandidate(row) {
    if (!row) return null;
    return {
      contractVersion: 1, id: row.id, organizationId: row.organization_id, siteId: row.site_id,
      title: row.title, rationale: row.rationale, baselineVersion: row.baseline_version,
      proposedVersion: row.proposed_version, changeType: row.change_type,
      artifactSha256: row.artifact_sha256, evaluationDatasetSha256: row.evaluation_dataset_sha256,
      evaluationPlan: JSON.parse(row.evaluation_plan_json), status: row.status,
      createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at,
      lastNote: row.last_note,
      evaluationStatus: row.evaluation_status || 'not_run', latestEvaluationId: row.latest_evaluation_id || null
    };
  }

  function audit(db, candidate, actorId, action, occurredAt, details) {
    db.prepare('INSERT INTO spais_audit_events (event_id, organization_id, site_id, actor_id, action, resource_type, resource_id, occurred_at, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), candidate.organizationId, candidate.siteId, actorId, action, 'model_candidate', candidate.id, occurredAt, JSON.stringify(details));
  }

  return {
    configured: Boolean(path),
    async create({ organizationId, actorId, input, now = new Date() }) {
      const validation = validateLearningCandidateInput(input);
      if (!validation.valid) throw Object.assign(fail('invalid_learning_candidate'), { validationErrors: validation.errors });
      if (!isResourceId(organizationId) || !isResourceId(actorId)) throw fail('invalid_trusted_scope');
      const db = await getDatabase();
      const timestamp = now.toISOString();
      const candidate = {
        contractVersion: 1, id: randomUUID(), organizationId, siteId: input.siteId,
        title: input.title.trim(), rationale: input.rationale.trim(),
        baselineVersion: input.baselineVersion.trim(), proposedVersion: input.proposedVersion.trim(),
        changeType: input.changeType, artifactSha256: input.artifactSha256.toLowerCase(),
        evaluationDatasetSha256: input.evaluationDatasetSha256.toLowerCase(),
        evaluationPlan: input.evaluationPlan.map(item => item.trim()),
        status: 'proposed', createdBy: actorId, createdAt: timestamp, updatedAt: timestamp, lastNote: null
      };
      db.exec('BEGIN IMMEDIATE;');
      try {
        db.prepare('INSERT INTO spais_model_candidates (id, organization_id, site_id, title, rationale, baseline_version, proposed_version, change_type, artifact_sha256, evaluation_dataset_sha256, evaluation_plan_json, status, created_by, created_at, updated_at, last_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)')
          .run(candidate.id, organizationId, candidate.siteId, candidate.title, candidate.rationale, candidate.baselineVersion, candidate.proposedVersion, candidate.changeType, candidate.artifactSha256, candidate.evaluationDatasetSha256, JSON.stringify(candidate.evaluationPlan), candidate.status, actorId, timestamp, timestamp);
        audit(db, candidate, actorId, 'model_candidate.created', timestamp, {
          status: candidate.status, changeType: candidate.changeType,
          artifactSha256: candidate.artifactSha256, evaluationDatasetSha256: candidate.evaluationDatasetSha256
        });
        db.exec('COMMIT;');
      } catch (error) { try { db.exec('ROLLBACK;'); } catch {} throw error; }
      return candidate;
    },
    async get({ organizationId, siteId, candidateId }) {
      if (![organizationId, siteId, candidateId].every(isResourceId)) throw fail('invalid_learning_candidate_query');
      const db = await getDatabase();
      return toCandidate(db.prepare('SELECT * FROM spais_model_candidates WHERE organization_id = ? AND site_id = ? AND id = ?').get(organizationId, siteId, candidateId));
    },
    async list({ organizationId, siteId, limit = 100 }) {
      if (![organizationId, siteId].every(isResourceId)) throw fail('invalid_learning_candidate_query');
      const db = await getDatabase();
      const bounded = Number.isInteger(limit) ? Math.max(1, Math.min(100, limit)) : 100;
      return db.prepare('SELECT * FROM spais_model_candidates WHERE organization_id = ? AND site_id = ? ORDER BY sequence DESC LIMIT ?')
        .all(organizationId, siteId, bounded).map(toCandidate);
    },
    async transition({ organizationId, siteId, candidateId, actorId, status, note, now = new Date() }) {
      const validation = validateLearningCandidateTransition({ status, note });
      if (!validation.valid) throw Object.assign(fail('invalid_learning_candidate_transition'), { validationErrors: validation.errors });
      if (![organizationId, siteId, candidateId, actorId].every(isResourceId)) throw fail('invalid_trusted_scope');
      const db = await getDatabase();
      const timestamp = now.toISOString();
      db.exec('BEGIN IMMEDIATE;');
      try {
        const row = db.prepare('SELECT * FROM spais_model_candidates WHERE organization_id = ? AND site_id = ? AND id = ?').get(organizationId, siteId, candidateId);
        if (!row) throw fail('learning_candidate_not_found');
        const before = toCandidate(row);
        const allowed = {
          proposed: new Set(['under_review', 'rejected']),
          under_review: new Set(['evaluation_pending', 'rejected']),
          evaluation_pending: new Set(['rejected']),
          rejected: new Set()
        };
        if (!allowed[before.status].has(status)) throw fail('invalid_learning_candidate_transition');
        if (status === 'evaluation_pending' && actorId === before.createdBy) throw fail('learning_candidate_self_approval_denied');
        db.prepare('UPDATE spais_model_candidates SET status = ?, updated_at = ?, last_note = ? WHERE organization_id = ? AND site_id = ? AND id = ?')
          .run(status, timestamp, note.trim(), organizationId, siteId, candidateId);
        const after = toCandidate(db.prepare('SELECT * FROM spais_model_candidates WHERE organization_id = ? AND site_id = ? AND id = ?').get(organizationId, siteId, candidateId));
        audit(db, after, actorId, 'model_candidate.status_changed', timestamp, { beforeStatus: before.status, afterStatus: status, note: note.trim() });
        db.exec('COMMIT;');
        return after;
      } catch (error) { try { db.exec('ROLLBACK;'); } catch {} throw error; }
    },
    async listEvaluations({ organizationId, siteId, candidateId, limit = 100 }) {
      if (![organizationId, siteId, candidateId].every(isResourceId)) throw fail('invalid_learning_evaluation_query');
      const db = await getDatabase();
      const bounded = Number.isInteger(limit) ? Math.max(1, Math.min(100, limit)) : 100;
      return db.prepare('SELECT * FROM spais_model_evaluations WHERE organization_id = ? AND site_id = ? AND candidate_id = ? ORDER BY sequence DESC LIMIT ?')
        .all(organizationId, siteId, candidateId, bounded).map(row => ({
          contractVersion: 1, id: row.id, organizationId: row.organization_id, siteId: row.site_id,
          candidateId: row.candidate_id, runId: row.run_id, artifactSha256: row.artifact_sha256,
          evaluationDatasetSha256: row.evaluation_dataset_sha256, evaluatorVersion: row.evaluator_version,
          evaluatorKeyId: row.evaluator_key_id, evaluatedAt: row.evaluated_at, receivedAt: row.received_at,
          sampleCount: row.sample_count, precision: row.precision, recall: row.recall,
          falsePositiveRate: row.false_positive_rate, result: row.result,
          thresholds: JSON.parse(row.thresholds_json), attestationSha256: row.attestation_sha256
        }));
    },
    async recordEvaluation({ organizationId, siteId, candidateId, actorId, report, verification, now = new Date() }) {
      if (![organizationId, siteId, candidateId, actorId].every(isResourceId)) throw fail('invalid_trusted_scope');
      if (!verification?.valid || !['passed', 'failed'].includes(verification.result)) throw fail('invalid_evaluation_attestation');
      const db = await getDatabase();
      const timestamp = now.toISOString();
      const evaluationId = randomUUID();
      db.exec('BEGIN IMMEDIATE;');
      try {
        const row = db.prepare('SELECT * FROM spais_model_candidates WHERE organization_id = ? AND site_id = ? AND id = ?')
          .get(organizationId, siteId, candidateId);
        if (!row) throw fail('learning_candidate_not_found');
        const candidate = toCandidate(row);
        if (candidate.status !== 'evaluation_pending') throw fail('learning_candidate_not_evaluation_pending');
        if (candidate.artifactSha256 !== report.artifactSha256.toLowerCase() ||
            candidate.evaluationDatasetSha256 !== report.evaluationDatasetSha256.toLowerCase()) {
          throw fail('learning_evaluation_digest_mismatch');
        }
        db.prepare(`
          INSERT INTO spais_model_evaluations
            (id, organization_id, site_id, candidate_id, run_id, nonce, artifact_sha256,
             evaluation_dataset_sha256, evaluator_version, evaluator_key_id, evaluated_at,
             received_at, sample_count, precision, recall, false_positive_rate, result,
             thresholds_json, attestation_sha256)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          evaluationId, organizationId, siteId, candidateId, report.runId, report.nonce,
          report.artifactSha256.toLowerCase(), report.evaluationDatasetSha256.toLowerCase(),
          report.evaluatorVersion.trim(), verification.evaluatorKeyId, new Date(Date.parse(report.evaluatedAt)).toISOString(),
          timestamp, report.sampleCount, report.precision, report.recall, report.falsePositiveRate,
          verification.result, JSON.stringify(verification.thresholds), verification.attestationSha256
        );
        db.prepare('UPDATE spais_model_candidates SET evaluation_status = ?, latest_evaluation_id = ?, updated_at = ? WHERE organization_id = ? AND site_id = ? AND id = ?')
          .run(verification.result, evaluationId, timestamp, organizationId, siteId, candidateId);
        audit(db, candidate, actorId, 'model_candidate.evaluation_' + verification.result, timestamp, {
          evaluationId, runId: report.runId, result: verification.result,
          sampleCount: report.sampleCount, precision: report.precision, recall: report.recall,
          falsePositiveRate: report.falsePositiveRate, thresholds: verification.thresholds,
          evaluatorKeyId: verification.evaluatorKeyId, attestationSha256: verification.attestationSha256
        });
        db.exec('COMMIT;');
        return (await this.listEvaluations({ organizationId, siteId, candidateId, limit: 1 }))[0];
      } catch (error) {
        try { db.exec('ROLLBACK;'); } catch {}
        if (error.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/.test(error.message)) {
          throw fail('learning_evaluation_replay_detected');
        }
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
