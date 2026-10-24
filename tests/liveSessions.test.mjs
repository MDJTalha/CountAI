import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIVE_SESSIONS_KEY, startLiveSession, recordLiveSessionEvent,
  finishLiveSession, listLiveSessions, deleteLiveSession
} from '../src/storage/liveSessions.mjs';

function memoryStorage() {
  const data = new Map();
  return {
    getItem: key => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key)
  };
}

test('starts a local session with a versioned start event and zero counts', () => {
  const storage = memoryStorage();
  const session = startLiveSession(storage, {
    id: 'session-a', startedAt: '2026-10-24T03:00:00.000Z',
    requestedResolution: '720p', actualResolution: '1280 x 720',
    linePosition: 50, detectionMode: 'people'
  });
  assert.equal(session.status, 'running');
  assert.equal(session.totalCrossings, 0);
  assert.equal(session.events[0].type, 'live_session_started');
  assert.equal(JSON.parse(storage.getItem(LIVE_SESSIONS_KEY)).length, 1);
});

test('records crossing totals and direction from validated events', () => {
  const storage = memoryStorage();
  startLiveSession(storage, { id: 'session-b', startedAt: '2026-10-24T03:00:00.000Z', linePosition: 45 });
  assert.equal(recordLiveSessionEvent(storage, 'session-b', 'crossing_counted', {
    direction: 'A-to-B', category: 'person', trackId: 3
  }, 'system', '2026-10-24T03:00:01.000Z'), true);
  assert.equal(recordLiveSessionEvent(storage, 'session-b', 'crossing_counted', {
    direction: 'B-to-A', category: 'person', trackId: 4
  }, 'system', '2026-10-24T03:00:02.000Z'), true);
  const [session] = listLiveSessions(storage);
  assert.equal(session.totalCrossings, 2);
  assert.equal(session.totals.person, 2);
  assert.deepEqual(session.directions, { 'A-to-B': 1, 'B-to-A': 1 });
});

test('rejects invalid events and refuses appends to closed or unknown sessions', () => {
  const storage = memoryStorage();
  startLiveSession(storage, { id: 'session-c', startedAt: '2026-10-24T03:00:00.000Z' });
  assert.equal(recordLiveSessionEvent(storage, 'session-c', 'crossing_counted', {
    direction: 'left', category: 'person', trackId: -1
  }), false);
  assert.equal(recordLiveSessionEvent(storage, 'missing', 'camera_health_changed', { status: 'healthy' }), false);
  finishLiveSession(storage, 'session-c', { endedAt: '2026-10-24T03:01:00.000Z', reason: 'operator_stopped' });
  assert.equal(recordLiveSessionEvent(storage, 'session-c', 'camera_health_changed', { status: 'healthy' }), false);
});

test('finishes sessions once and persists the final count snapshot', () => {
  const storage = memoryStorage();
  startLiveSession(storage, { id: 'session-d', startedAt: '2026-10-24T03:00:00.000Z' });
  const result = finishLiveSession(storage, 'session-d', {
    endedAt: '2026-10-24T03:02:00.000Z', reason: 'camera_disconnected',
    totalCrossings: 5, totals: { person: 5 }, directions: { 'A-to-B': 3, 'B-to-A': 2 }
  });
  assert.equal(result.status, 'stopped');
  assert.equal(result.totalCrossings, 5);
  assert.equal(result.stopReason, 'camera_disconnected');
  assert.equal(finishLiveSession(storage, 'session-d'), false);
});

test('supports deletion and recovers safely from corrupt local storage', () => {
  const storage = memoryStorage();
  storage.setItem(LIVE_SESSIONS_KEY, '{not-json');
  assert.deepEqual(listLiveSessions(storage), []);
  startLiveSession(storage, { id: 'session-e', startedAt: '2026-10-24T03:00:00.000Z' });
  assert.equal(deleteLiveSession(storage, 'session-e'), true);
  assert.equal(deleteLiveSession(storage, 'session-e'), false);
});
