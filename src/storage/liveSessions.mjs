import { createOperationalEvent, validateOperationalEvent } from '../engine/operationalEvents.mjs';

export const LIVE_SESSIONS_KEY = 'countai.liveSessions.v1';
const MAX_SESSIONS = 40;
const MAX_EVENTS_PER_SESSION = 250;

function safeParse(value) {
  try {
    const parsed = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readSessions(storage) {
  return safeParse(storage.getItem(LIVE_SESSIONS_KEY))
    .filter(item => item && typeof item.id === 'string' && typeof item.startedAt === 'string');
}

function writeSessions(storage, sessions) {
  storage.setItem(LIVE_SESSIONS_KEY, JSON.stringify(sessions.slice(0, MAX_SESSIONS)));
}

function newId(prefix = 'live') {
  const uuid = globalThis.crypto?.randomUUID?.();
  return prefix + '-' + (uuid ?? Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10));
}

function makeEvent(sessionId, type, payload, actorType = 'system', occurredAt = new Date().toISOString()) {
  return createOperationalEvent({ id: newId('evt'), type, occurredAt, sessionId, actorType, payload });
}

function appendToRecord(record, event) {
  const events = [...(record.events ?? []), event];
  const dropped = Math.max(0, events.length - MAX_EVENTS_PER_SESSION);
  record.events = events.slice(-MAX_EVENTS_PER_SESSION);
  record.eventCount = (record.eventCount ?? 0) + 1;
  record.droppedEventCount = (record.droppedEventCount ?? 0) + dropped;
  record.lastEventAt = event.occurredAt;

  if (event.type === 'crossing_counted') {
    const { category, direction } = event.payload;
    record.totalCrossings = (record.totalCrossings ?? 0) + 1;
    record.totals = { ...(record.totals ?? {}), [category]: ((record.totals ?? {})[category] ?? 0) + 1 };
    record.directions = { ...(record.directions ?? { 'A-to-B': 0, 'B-to-A': 0 }), [direction]: ((record.directions ?? { 'A-to-B': 0, 'B-to-A': 0 })[direction] ?? 0) + 1 };
  }
  if (event.type === 'camera_health_changed') record.cameraHealth = event.payload.status;
  if (event.type === 'inference_health_changed') record.inferenceHealth = event.payload.status;
}

export function startLiveSession(storage, options) {
  const id = options.id || newId();
  const startedAt = options.startedAt || new Date().toISOString();
  const record = {
    id, startedAt, endedAt: null, status: 'running', stopReason: null,
    mode: 'live', requestedResolution: options.requestedResolution,
    actualResolution: options.actualResolution, linePosition: options.linePosition,
    detectionMode: options.detectionMode, totalCrossings: 0, totals: {},
    directions: { 'A-to-B': 0, 'B-to-A': 0 }, cameraHealth: 'healthy',
    inferenceHealth: 'unknown', events: [], eventCount: 0, droppedEventCount: 0,
    lastEventAt: startedAt
  };
  const event = makeEvent(id, 'live_session_started', { mode: 'live' }, 'system', startedAt);
  appendToRecord(record, event);
  const sessions = readSessions(storage).filter(item => item.id !== id);
  writeSessions(storage, [record, ...sessions]);
  return record;
}

export function appendLiveSessionEvent(storage, sessionId, event) {
  const validation = validateOperationalEvent(event);
  if (!validation.valid || event.sessionId !== sessionId) return false;
  const sessions = readSessions(storage);
  const index = sessions.findIndex(item => item.id === sessionId && item.status === 'running');
  if (index < 0) return false;
  appendToRecord(sessions[index], event);
  writeSessions(storage, sessions);
  return true;
}

export function recordLiveSessionEvent(storage, sessionId, type, payload, actorType = 'system', occurredAt = new Date().toISOString()) {
  return appendLiveSessionEvent(storage, sessionId, makeEvent(sessionId, type, payload, actorType, occurredAt));
}

export function finishLiveSession(storage, sessionId, options = {}) {
  const sessions = readSessions(storage);
  const record = sessions.find(item => item.id === sessionId && item.status === 'running');
  if (!record) return false;
  const endedAt = options.endedAt || new Date().toISOString();
  const reason = options.reason || 'operator_stopped';
  appendToRecord(record, makeEvent(sessionId, 'live_session_stopped', { reason }, 'system', endedAt));
  record.endedAt = endedAt;
  record.status = 'stopped';
  record.stopReason = reason;
  if (options.actualResolution) record.actualResolution = options.actualResolution;
  if (Number.isFinite(options.linePosition)) record.linePosition = options.linePosition;
  if (options.detectionMode) record.detectionMode = options.detectionMode;
  if (options.totals) record.totals = { ...options.totals };
  if (options.directions) record.directions = { ...options.directions };
  if (Number.isFinite(options.totalCrossings)) record.totalCrossings = options.totalCrossings;
  writeSessions(storage, sessions);
  return record;
}

export function listLiveSessions(storage) {
  return readSessions(storage).map(record => ({ ...record, events: [...(record.events ?? [])] }));
}

export function deleteLiveSession(storage, sessionId) {
  const sessions = readSessions(storage);
  const next = sessions.filter(item => item.id !== sessionId);
  writeSessions(storage, next);
  return next.length !== sessions.length;
}
