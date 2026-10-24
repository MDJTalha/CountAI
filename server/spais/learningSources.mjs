import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, chmod, unlink } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { isResourceId } from './contracts.mjs';

const TYPES = new Set(['document', 'image', 'observation', 'video_recording']);
const MAX_TEXT = 256 * 1024;
const MAX_FILE = 8 * 1024 * 1024;
const FILE_TYPES = new Map([
  ['text/plain', { ext: '.txt', kind: 'document' }],
  ['text/markdown', { ext: '.md', kind: 'document' }],
  ['text/csv', { ext: '.csv', kind: 'document' }],
  ['application/json', { ext: '.json', kind: 'document' }],
  ['application/pdf', { ext: '.pdf', kind: 'document' }],
  ['image/jpeg', { ext: '.jpg', kind: 'image' }],
  ['image/png', { ext: '.png', kind: 'image' }],
  ['image/webp', { ext: '.webp', kind: 'image' }],
  ['video/webm', { ext: '.webm', kind: 'video_recording' }],
  ['video/mp4', { ext: '.mp4', kind: 'video_recording' }]
]);
const SENSITIVE = /(password|secret|token|credential|authorization|private.?key|api.?key|rtsp.?url|stream.?url)/i;
const fail = code => Object.assign(new Error(code), { code });
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max;

export function validateLearningSourceInput(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { valid: false, errors: ['body_must_be_object'] };
  const allowed = new Set(['siteId', 'sourceType', 'title', 'description', 'fileName', 'mimeType', 'contentText', 'fileBase64', 'observedAt', 'cameraId', 'labels', 'consentConfirmed']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) errors.push('unsupported_field:' + key);
  if (!isResourceId(input.siteId)) errors.push('site_id_required');
  if (!TYPES.has(input.sourceType)) errors.push('invalid_source_type');
  if (!text(input.title, 180)) errors.push('title_must_be_1_to_180_characters');
  if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 2000)) errors.push('description_too_long');
  if (input.cameraId !== undefined && !isResourceId(input.cameraId)) errors.push('invalid_camera_id');
  if (input.observedAt !== undefined && (!text(input.observedAt, 64) || !Number.isFinite(Date.parse(input.observedAt)))) errors.push('invalid_observed_at');
  if (input.consentConfirmed !== true) errors.push('explicit_data_authorization_required');
  if (input.labels !== undefined && (!Array.isArray(input.labels) || input.labels.length > 30 || input.labels.some(label => !text(label, 80)))) errors.push('invalid_labels');
  if (input.contentText !== undefined && (typeof input.contentText !== 'string' || Buffer.byteLength(input.contentText, 'utf8') > MAX_TEXT)) errors.push('content_text_too_large');
  const hasFile = input.fileBase64 !== undefined || input.fileName !== undefined || input.mimeType !== undefined;
  if (hasFile) {
    if (!text(input.fileName, 180) || /[/\\\\]/.test(input.fileName) || input.fileName === '.' || input.fileName === '..') errors.push('invalid_file_name');
    if (!FILE_TYPES.has(input.mimeType)) errors.push('unsupported_file_type');
    if (typeof input.fileBase64 !== 'string' || input.fileBase64.length > Math.ceil(MAX_FILE * 4 / 3) + 16) errors.push('file_payload_too_large_or_missing');
    if (FILE_TYPES.has(input.mimeType) && FILE_TYPES.get(input.mimeType).kind !== input.sourceType) errors.push('file_type_source_type_mismatch');
  }
  if (input.sourceType === 'document' && !input.contentText && !hasFile) errors.push('document_content_required');
  if (input.sourceType === 'image' && !hasFile) errors.push('image_file_required');
  if (input.sourceType === 'video_recording' && !hasFile) errors.push('video_file_required');
  if (input.sourceType === 'observation' && !text(input.contentText, 4000)) errors.push('observation_text_required');
  for (const key of Object.keys(input)) if (SENSITIVE.test(key)) errors.push('sensitive_field_forbidden');
  return { valid: errors.length === 0, errors };
}

/**
 * Stores tenant/site-scoped learning-source metadata and explicitly authorized
 * small media assets on the customer-controlled host. This does not train a
 * model, infer labels, or promote model versions.
 */
export function createSqliteLearningSourceStore({
  databasePath = process.env.SPAIS_EVENTS_DB_PATH,
  mediaDirectory = process.env.COUNTAI_LEARNING_MEDIA_DIR || './data/learning-media'
} = {}) {
  const dbPath = typeof databasePath === 'string' && databasePath.trim()
    ? (databasePath === ':memory:' ? ':memory:' : resolve(databasePath)) : null;
  const mediaRoot = resolve(mediaDirectory);
  let databasePromise;
  async function db() {
    if (!dbPath) throw fail('learning_source_store_not_configured');
    if (!databasePromise) databasePromise = (async () => {
      if (dbPath !== ':memory:') await mkdir(dirname(dbPath), { recursive: true });
      const { DatabaseSync } = await import('node:sqlite');
      const database = new DatabaseSync(dbPath);
      database.exec('PRAGMA foreign_keys = ON;');
      if (dbPath !== ':memory:') database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      database.exec(`
        CREATE TABLE IF NOT EXISTS countai_learning_sources (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          organization_id TEXT NOT NULL,
          site_id TEXT NOT NULL,
          source_type TEXT NOT NULL CHECK(source_type IN ('document','image','observation','video_recording')),
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          content_text TEXT,
          file_name TEXT,
          mime_type TEXT,
          media_path TEXT,
          sha256 TEXT,
          byte_size INTEGER NOT NULL DEFAULT 0,
          camera_id TEXT,
          observed_at TEXT,
          labels_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('ingested','awaiting_annotation','ready_for_review')),
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL,
          consent_confirmed INTEGER NOT NULL CHECK(consent_confirmed = 1)
        );
        CREATE INDEX IF NOT EXISTS idx_countai_learning_sources_scope
          ON countai_learning_sources(organization_id, site_id, sequence DESC);
        CREATE TABLE IF NOT EXISTS countai_learning_source_audit (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          source_id TEXT NOT NULL,
          organization_id TEXT NOT NULL,
          site_id TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          action TEXT NOT NULL,
          occurred_at TEXT NOT NULL
        );
      `);
      return database;
    })();
    return databasePromise;
  }
  function map(row, includeText = false) {
    if (!row) return null;
    return {
      id: row.id, organizationId: row.organization_id, siteId: row.site_id,
      sourceType: row.source_type, title: row.title, description: row.description,
      contentText: includeText ? row.content_text : undefined, fileName: row.file_name, mimeType: row.mime_type,
      sha256: row.sha256, byteSize: row.byte_size, cameraId: row.camera_id,
      observedAt: row.observed_at, labels: JSON.parse(row.labels_json), status: row.status,
      createdBy: row.created_by, createdAt: row.created_at,
      mediaStored: Boolean(row.media_path), learningState: 'queued_for_review'
    };
  }
  return {
    get configured() { return Boolean(dbPath); },
    async create({ organizationId, principal, input }) {
      const validation = validateLearningSourceInput(input);
      if (!validation.valid) throw Object.assign(fail('invalid_learning_source'), { validationErrors: validation.errors });
      const database = await db();
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      let mediaPath = null;
      let contentText = input.contentText?.trim() || null;
      let sha256 = null;
      let byteSize = contentText ? Buffer.byteLength(contentText, 'utf8') : 0;
      if (input.fileBase64 !== undefined) {
        const fileType = FILE_TYPES.get(input.mimeType);
        const bytes = Buffer.from(input.fileBase64, 'base64');
        if (!bytes.length || bytes.length > MAX_FILE || bytes.toString('base64').replace(/=+$/, '') !== input.fileBase64.replace(/=+$/, '')) {
          throw fail('invalid_or_oversized_file_payload');
        }
        // Check signatures rather than trusting the browser-provided MIME label.
        const signatureOkay = input.mimeType === 'application/pdf' ? bytes.toString('ascii', 0, 5) === '%PDF-'
          : input.mimeType === 'image/jpeg' ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
          : input.mimeType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
          : input.mimeType === 'image/webp' ? bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
          : input.mimeType === 'video/webm' ? bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
          : input.mimeType === 'video/mp4' ? bytes.toString('ascii', 4, 8) === 'ftyp'
          : true;
        if (!signatureOkay) throw fail('file_signature_mismatch');
        await mkdir(mediaRoot, { recursive: true });
        mediaPath = join(mediaRoot, id + fileType.ext);
        await writeFile(mediaPath, bytes, { flag: 'wx', mode: 0o600 });
        try { await chmod(mediaPath, 0o600); } catch {}
        sha256 = createHash('sha256').update(bytes).digest('hex');
        byteSize = bytes.byteLength;
        // Plain-text formats are indexed as text; binary formats remain quarantined assets.
        if (['text/plain','text/markdown','text/csv','application/json'].includes(input.mimeType)) {
          contentText = bytes.toString('utf8');
          if (Buffer.byteLength(contentText, 'utf8') > MAX_TEXT) {
            try { const { unlink } = await import('node:fs/promises'); await unlink(mediaPath); } catch {}
            throw fail('document_text_too_large');
          }
        }
      }
      const status = input.sourceType === 'observation' || contentText ? 'ready_for_review' : 'awaiting_annotation';
      try {
        database.exec('BEGIN IMMEDIATE');
        database.prepare(`
          INSERT INTO countai_learning_sources
          (id,organization_id,site_id,source_type,title,description,content_text,file_name,mime_type,media_path,sha256,byte_size,camera_id,observed_at,labels_json,status,created_by,created_at,consent_confirmed)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
        `).run(id, organizationId, input.siteId, input.sourceType, input.title.trim(),
          (input.description || '').trim(), contentText, input.fileName || null, input.mimeType || null,
          mediaPath, sha256, byteSize, input.cameraId || null, input.observedAt || createdAt,
          JSON.stringify(input.labels || []), status, (principal.subjectId || principal.sub || 'unknown-actor'), createdAt);
        database.prepare('INSERT INTO countai_learning_source_audit (source_id,organization_id,site_id,actor_id,action,occurred_at) VALUES (?,?,?,?,?,?)')
          .run(id, organizationId, input.siteId, (principal.subjectId || principal.sub || 'unknown-actor'), 'learning_source.ingested', createdAt);
        database.exec('COMMIT');
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        if (mediaPath) { try { const { unlink } = await import('node:fs/promises'); await unlink(mediaPath); } catch {} }
        throw error;
      }
      return map(database.prepare('SELECT * FROM countai_learning_sources WHERE id = ?').get(id), true);
    },
    async list({ organizationId, siteId, limit = 100 }) {
      const database = await db();
      return database.prepare('SELECT * FROM countai_learning_sources WHERE organization_id = ? AND site_id = ? ORDER BY sequence DESC LIMIT ?')
        .all(organizationId, siteId, Math.max(1, Math.min(100, limit))).map(row => map(row, false));
    },
    async delete({ organizationId, siteId, sourceId, actorId, action = 'learning_source.deleted' }) {
      if (!isResourceId(organizationId) || !isResourceId(siteId) || !isResourceId(sourceId) ||
          typeof actorId !== 'string' || !actorId.trim() || !['learning_source.deleted', 'learning_source.retention_expired'].includes(action)) {
        throw fail('invalid_learning_source_delete');
      }
      const database = await db();
      const row = database.prepare('SELECT id, media_path FROM countai_learning_sources WHERE organization_id = ? AND site_id = ? AND id = ?')
        .get(organizationId, siteId, sourceId);
      if (!row) return { deleted: false, mediaCleanupPending: false };
      // Delete media first. If cleanup fails, preserve the source record so an
      // authorized operator can retry rather than silently orphaning customer data.
      if (row.media_path) {
        try { await unlink(row.media_path); }
        catch (error) {
          if (error.code !== 'ENOENT') throw Object.assign(fail('learning_source_media_cleanup_failed'), { cause: error });
        }
      }
      const occurredAt = new Date().toISOString();
      database.exec('BEGIN IMMEDIATE');
      try {
        database.prepare('DELETE FROM countai_learning_sources WHERE organization_id = ? AND site_id = ? AND id = ?')
          .run(organizationId, siteId, sourceId);
        database.prepare('INSERT INTO countai_learning_source_audit (source_id,organization_id,site_id,actor_id,action,occurred_at) VALUES (?,?,?,?,?,?)')
          .run(sourceId, organizationId, siteId, actorId, action, occurredAt);
        database.exec('COMMIT');
      } catch (error) {
        try { database.exec('ROLLBACK'); } catch {}
        throw error;
      }
      return { deleted: true, mediaCleanupPending: false };
    },
    async purgeExpired({ retentionDays = Number(process.env.COUNTAI_LEARNING_SOURCE_RETENTION_DAYS || 0), now = Date.now() } = {}) {
      if (!Number.isInteger(retentionDays) || retentionDays < 0 || retentionDays > 3650 || !Number.isFinite(now)) {
        throw fail('invalid_learning_source_retention');
      }
      if (retentionDays === 0) return { deleted: 0, mediaCleanupPending: 0, disabled: true };
      const database = await db();
      const cutoff = new Date(now - retentionDays * 24 * 60 * 60 * 1000).toISOString();
      const expired = database.prepare('SELECT id, organization_id, site_id, created_by FROM countai_learning_sources WHERE created_at < ? ORDER BY sequence ASC')
        .all(cutoff);
      let deleted = 0;
      let mediaCleanupPending = 0;
      for (const row of expired) {
        const result = await this.delete({
          organizationId: row.organization_id, siteId: row.site_id, sourceId: row.id,
          actorId: 'system-retention', action: 'learning_source.retention_expired'
        });
        if (result.deleted) deleted += 1;
        if (result.mediaCleanupPending) mediaCleanupPending += 1;
      }
      return { deleted, mediaCleanupPending, disabled: false, retentionDays, cutoff };
    },
    async close() {
      if (!databasePromise) return;
      const database = await databasePromise;
      database.close();
      databasePromise = undefined;
    }
  };
}
