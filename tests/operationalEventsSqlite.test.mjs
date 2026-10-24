import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteOperationalEventStore } from '../server/spais/operationalEvents.mjs';

function event(id, organizationId, siteId = null) {
  return {
    id,
    contractVersion: 1,
    resourceType: 'operational_event',
    organizationId,
    siteId,
    actorId: 'operator-1',
    eventType: 'session.started',
    sessionId: `session-${id}`,
    occurredAt: '2026-10-24T04:00:00.000Z',
    recordedAt: '2026-10-24T04:00:01.000Z',
    details: { source: 'test' }
  };
}

test('SQLite event store persists across reopen and enforces organization/site filters', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spais-sqlite-events-'));
  const path = join(dir, 'events.sqlite');
  let store;
  try {
    store = createSqliteOperationalEventStore(path);
    assert.equal(store.configured, true);
    await store.append(event('e1', 'org-1', 'site-1'));
    await store.append(event('e2', 'org-2', 'site-1'));
    await store.append(event('e3', 'org-1', 'site-2'));
    await store.append(event('e4', 'org-1', 'site-1'));
    await store.close();

    store = createSqliteOperationalEventStore(path);
    assert.deepEqual((await store.list({ organizationId: 'org-1' })).map(item => item.id), ['e4', 'e3', 'e1']);
    assert.deepEqual((await store.list({ organizationId: 'org-1', siteId: 'site-1' })).map(item => item.id), ['e4', 'e1']);
    assert.deepEqual((await store.list({ organizationId: 'org-2' })).map(item => item.id), ['e2']);
    assert.deepEqual(await store.list({ organizationId: 'org-3' }), []);
  } finally {
    if (store) await store.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test('SQLite event store bounds result limits and rejects duplicate event IDs atomically', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spais-sqlite-events-'));
  const store = createSqliteOperationalEventStore(join(dir, 'events.sqlite'));
  try {
    for (let i = 1; i <= 4; i += 1) await store.append(event(`e${i}`, 'org-1', 'site-1'));
    assert.deepEqual((await store.list({ organizationId: 'org-1', limit: 2 })).map(item => item.id), ['e4', 'e3']);
    await assert.rejects(() => store.append(event('e4', 'org-attacker', 'site-1')));
    assert.deepEqual((await store.list({ organizationId: 'org-1' })).map(item => item.id), ['e4', 'e3', 'e2', 'e1']);
    assert.deepEqual(await store.list({ organizationId: 'org-attacker' }), []);
  } finally {
    await store.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test('SQLite event store fails closed when no database path is configured', async () => {
  const store = createSqliteOperationalEventStore('');
  assert.equal(store.configured, false);
  await assert.rejects(() => store.append(event('e1', 'org-1')), { code: 'event_store_not_configured' });
});
