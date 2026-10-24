import test from 'node:test';
import assert from 'node:assert/strict';
import { createOperationalEvent, validateOperationalEvent } from '../src/engine/operationalEvents.mjs';

const base = {
  id: 'evt-001',
  type: 'crossing_counted',
  occurredAt: '2026-10-24T03:00:00.000Z',
  sessionId: 'session-001',
  actorType: 'system',
  payload: { direction: 'A-to-B', category: 'person', trackId: 7 }
};

test('accepts a valid versioned crossing event', () => {
  const event = createOperationalEvent(base);
  assert.equal(event.schemaVersion, 1);
  assert.deepEqual(validateOperationalEvent(event), { valid: true, errors: [] });
});

test('rejects unknown schema versions and unsupported event types', () => {
  const result = validateOperationalEvent({ ...base, schemaVersion: 2, type: 'arbitrary_event' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.includes('schemaVersion')));
  assert.ok(result.errors.some(error => error.includes('type')));
});

test('rejects malformed timestamps and missing session identity', () => {
  const result = validateOperationalEvent({ ...base, occurredAt: 'yesterday', sessionId: '' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.includes('occurredAt')));
  assert.ok(result.errors.some(error => error.includes('sessionId')));
});

test('rejects invalid crossing direction and track ID', () => {
  const result = validateOperationalEvent({
    ...base,
    payload: { direction: 'left', category: 'person', trackId: -1 }
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.includes('direction')));
  assert.ok(result.errors.some(error => error.includes('trackId')));
});

test('operator corrections require an operator actor and a supported action', () => {
  const result = validateOperationalEvent({
    ...base,
    type: 'operator_correction',
    actorType: 'system',
    payload: { action: 'train_model' }
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.includes('action')));
  assert.ok(result.errors.some(error => error.includes('actorType')));
});

test('constructor fails closed on invalid event data', () => {
  assert.throws(
    () => createOperationalEvent({ ...base, payload: { direction: 'unknown' } }),
    error => error instanceof TypeError && Array.isArray(error.validationErrors)
  );
});

test('count reset is an explicit operator-only event', () => {
  const event = createOperationalEvent({
    ...base,
    type: 'count_reset',
    actorType: 'operator',
    payload: { reason: 'operator_reset' }
  });
  assert.equal(validateOperationalEvent(event).valid, true);
  const invalid = validateOperationalEvent({ ...event, actorType: 'system' });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some(error => error.includes('actorType')));
});
