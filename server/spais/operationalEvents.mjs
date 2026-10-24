import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_STORE_BYTES = 64 * 1024 * 1024;
const MAX_EVENT_DETAILS_BYTES = 8 * 1024;
const EVENT_TYPES = new Set([
  'session.started',
  'session.stopped',
  'line.crossed',
  'camera.health',
  'operator.count_reset',
  'incident.created',
  'incident.updated',
  'sop.acknowledged'
]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function validateOperationalEvent(input) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, errors: ['body must be an object'] };
  }
  if (typeof input.eventType !== 'string' || !EVENT_TYPES.has(input.eventType)) {
    errors.push('eventType is not supported');
  }
  if (typeof input.sessionId !== 'string' || !ID_PATTERN.test(input.sessionId)) {
    errors.push('sessionId must be a valid resource identifier');
  }
  if (input.siteId !== undefined && input.siteId !== null &&
      (typeof input.siteId !== 'string' || !ID_PATTERN.test(input.siteId))) {
    errors.push('siteId must be a valid resource identifier');
  }
  if (input.occurredAt !== undefined &&
      (typeof input.occurredAt !== 'string' || !Number.isFinite(Date.parse(input.occurredAt)))) {
    errors.push('occurredAt must be a valid timestamp');
  }
  if (input.details !== undefined &&
      (!input.details || typeof input.details !== 'object' || Array.isArray(input.details))) {
    errors.push('details must be an object');
  }
  if (input.details !== undefined) {
    try {
      if (Buffer.byteLength(JSON.stringify(input.details), 'utf8') > MAX_EVENT_DETAILS_BYTES) {
        errors.push('details exceeds the 8 KiB limit');
      }
    } catch {
      errors.push('details must be JSON serializable');
    }
  }
  // Tenant and actor identifiers are assigned by the server, never accepted from the body.
  return { valid: errors.length === 0, errors };
}

function safeStorePath(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) return null;
  return resolve(filePath);
}

/**
 * Single-host append-only JSONL store for pilot/development use.
 * Production multi-instance deployments should replace this adapter with a
 * transactional database and managed retention/backup controls.
 */
export function createOperationalEventStore(filePath = process.env.SPAIS_EVENTS_FILE) {
  const path = safeStorePath(filePath);
  return {
    configured: Boolean(path),
    async append(event) {
      if (!path) throw Object.assign(new Error('event_store_not_configured'), { code: 'event_store_not_configured' });
      await mkdir(dirname(path), { recursive: true });
      let currentBytes = 0;
      try {
        currentBytes = (await stat(path)).size;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const line = JSON.stringify(event) + '\n';
      if (currentBytes + Buffer.byteLength(line, 'utf8') > MAX_STORE_BYTES) {
        throw Object.assign(new Error('event_store_limit_reached'), { code: 'event_store_limit_reached' });
      }
      await appendFile(path, line, { encoding: 'utf8', mode: 0o600 });
      return event;
    },
    async list({ organizationId, siteId, limit = 100 } = {}) {
      if (!path) throw Object.assign(new Error('event_store_not_configured'), { code: 'event_store_not_configured' });
      let text;
      try {
        text = await readFile(path, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
      const events = [];
      for (const line of text.split('\n')) {
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.organizationId !== organizationId) continue;
        if (siteId && event.siteId !== siteId) continue;
        events.push(event);
      }
      return events.slice(-Math.max(1, Math.min(100, Number.isInteger(limit) ? limit : 100))).reverse();
    }
  };
}

export function createOperationalEvent({ organizationId, actorId, input, now = new Date() }) {
  return {
    id: randomUUID(),
    contractVersion: 1,
    resourceType: 'operational_event',
    organizationId,
    siteId: input.siteId ?? null,
    actorId,
    eventType: input.eventType,
    sessionId: input.sessionId,
    occurredAt: input.occurredAt ?? now.toISOString(),
    recordedAt: now.toISOString(),
    details: input.details ?? {}
  };
}
