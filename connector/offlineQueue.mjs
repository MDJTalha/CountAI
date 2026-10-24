import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, chmod, writeFile, rm, lstat, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const MAX_ITEMS = 1000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 8 * 1024;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const EVENT_TYPES = new Set(['connector.heartbeat', 'camera.health', 'recorder.recording_coverage']);
const FORBIDDEN_KEY = /(image|frame|video|base64|password|secret|token|credential|authorization|private.?key|api.?key|stream.?url|rtsp.?url)/i;

function fail(code) {
  return Object.assign(new Error(code), { code });
}

function validatePayload(value, depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 8) return false;
  let serialized;
  try { serialized = JSON.stringify(value); } catch { return false; }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) return false;
  return Object.entries(value).every(([key, child]) => {
    if (FORBIDDEN_KEY.test(key)) return false;
    if (child && typeof child === 'object') {
      if (Array.isArray(child)) return false;
      return validatePayload(child, depth + 1);
    }
    return child === null || ['string', 'number', 'boolean'].includes(typeof child);
  });
}

function validateEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
      !ID_PATTERN.test(entry.deliveryId || '') || !EVENT_TYPES.has(entry.eventType) ||
      typeof entry.queuedAt !== 'string' || !Number.isFinite(Date.parse(entry.queuedAt)) ||
      !validatePayload(entry.payload)) throw fail('invalid_connector_queue_entry');
  return entry;
}

function normalizePath(path) {
  if (typeof path !== 'string' || !path.trim()) throw fail('connector_queue_path_required');
  return resolve(path);
}

export async function readTelemetryQueue(path) {
  const filePath = normalizePath(path);
  let text;
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile()) throw fail('connector_queue_not_regular_file');
    await chmod(filePath, 0o600).catch(() => {});
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw fail('connector_queue_too_large');
  let entries;
  try { entries = JSON.parse(text); } catch { throw fail('connector_queue_corrupt'); }
  if (!Array.isArray(entries) || entries.length > MAX_ITEMS) throw fail('connector_queue_invalid');
  const ids = new Set();
  for (const entry of entries) {
    validateEntry(entry);
    if (ids.has(entry.deliveryId)) throw fail('connector_queue_duplicate_delivery_id');
    ids.add(entry.deliveryId);
  }
  return entries;
}

export async function writeTelemetryQueue(path, entries) {
  const filePath = normalizePath(path);
  if (!Array.isArray(entries) || entries.length > MAX_ITEMS) throw fail('connector_queue_capacity_exceeded');
  const ids = new Set();
  for (const entry of entries) {
    validateEntry(entry);
    if (ids.has(entry.deliveryId)) throw fail('connector_queue_duplicate_delivery_id');
    ids.add(entry.deliveryId);
  }
  const text = JSON.stringify(entries) + '\n';
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw fail('connector_queue_capacity_exceeded');
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = filePath + '.tmp-' + randomUUID();
  try {
    const handle = await open(tempPath, 'wx', 0o600);
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(tempPath, 0o600).catch(() => {});
    await rename(tempPath, filePath);
    await chmod(filePath, 0o600).catch(() => {});
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
  return entries.length;
}

export async function enqueueTelemetry(path, events, now = new Date()) {
  if (!Array.isArray(events)) throw fail('invalid_connector_queue_batch');
  const queue = await readTelemetryQueue(path);
  const additions = events.map(event => validateEntry({
    deliveryId: randomUUID(),
    eventType: event.eventType,
    payload: event.payload,
    queuedAt: now.toISOString()
  }));
  const combined = queue.concat(additions);
  await writeTelemetryQueue(path, combined);
  return combined;
}

export async function acknowledgeTelemetry(path, deliveryId) {
  if (!ID_PATTERN.test(deliveryId || '')) throw fail('invalid_connector_queue_entry');
  const queue = await readTelemetryQueue(path);
  const index = queue.findIndex(entry => entry.deliveryId === deliveryId);
  if (index === -1) return queue;
  queue.splice(index, 1);
  await writeTelemetryQueue(path, queue);
  return queue;
}
