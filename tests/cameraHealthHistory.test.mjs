import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAMERA_HEALTH_HISTORY_KEY,
  appendCameraHealthEvent,
  loadCameraHealthHistory,
  saveCameraHealthHistory
} from '../src/engine/cameraHealthHistory.mjs';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    values
  };
}

test('health history appends state transitions but suppresses duplicate status/error pairs', () => {
  const first = appendCameraHealthEvent([], { timestamp: 1, status: 'starting', error: null });
  const duplicate = appendCameraHealthEvent(first, { timestamp: 2, status: 'starting', error: null });
  const next = appendCameraHealthEvent(duplicate, { timestamp: 3, status: 'healthy', error: null });
  assert.equal(duplicate.length, 1);
  assert.equal(next.length, 2);
  assert.equal(next[1].status, 'healthy');
});

test('health history is bounded to the configured number of entries', () => {
  let events = [];
  for (let timestamp = 1; timestamp <= 5; timestamp += 1) {
    events = appendCameraHealthEvent(events, { timestamp, status: `state-${timestamp}`, error: null }, 3);
  }
  assert.deepEqual(events.map(event => event.timestamp), [3, 4, 5]);
});

test('health history persists and reloads validated events', () => {
  const storage = memoryStorage();
  const events = [{ timestamp: 123, status: 'degraded', error: 'Video frames have stalled' }];
  assert.equal(saveCameraHealthHistory(storage, events), true);
  assert.equal(storage.values.has(CAMERA_HEALTH_HISTORY_KEY), true);
  assert.deepEqual(loadCameraHealthHistory(storage), events);
});

test('malformed or unavailable storage safely returns an empty history', () => {
  assert.deepEqual(loadCameraHealthHistory(memoryStorage({ [CAMERA_HEALTH_HISTORY_KEY]: '{broken' })), []);
  const throwingStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(loadCameraHealthHistory(throwingStorage), []);
  assert.equal(saveCameraHealthHistory(throwingStorage, []), false);
});
