import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createOperationalEvent,
  createOperationalEventStore,
  validateOperationalEvent
} from '../server/spais/operationalEvents.mjs';

test('validates supported operational events and rejects client-supplied tenant fields only by omission', () => {
  const input = {
    eventType: 'line.crossed',
    sessionId: 'session-1',
    siteId: 'site-1',
    occurredAt: '2026-10-24T04:00:00.000Z',
    details: { direction: 'in', category: 'person', count: 1 },
    organizationId: 'attacker-org',
    actorId: 'attacker-user'
  };
  assert.deepEqual(validateOperationalEvent(input), { valid: true, errors: [] });
  const event = createOperationalEvent({
    organizationId: 'trusted-org',
    actorId: 'trusted-user',
    input,
    now: new Date('2026-10-24T04:01:00.000Z')
  });
  assert.equal(event.organizationId, 'trusted-org');
  assert.equal(event.actorId, 'trusted-user');
  assert.equal(event.resourceType, 'operational_event');
  assert.equal(event.details.direction, 'in');
});

test('rejects unsupported event types, malformed IDs, invalid timestamps and oversized details', () => {
  assert.equal(validateOperationalEvent({ eventType: 'unknown', sessionId: 'session-1' }).valid, false);
  assert.equal(validateOperationalEvent({ eventType: 'line.crossed', sessionId: '../escape' }).valid, false);
  assert.equal(validateOperationalEvent({ eventType: 'session.started', sessionId: 'session-1', occurredAt: 'not-a-date' }).valid, false);
  assert.equal(validateOperationalEvent({
    eventType: 'session.started',
    sessionId: 'session-1',
    details: { large: 'x'.repeat(9000) }
  }).valid, false);
  assert.equal(validateOperationalEvent([]).valid, false);
});

test('fails closed when the event store path is not configured', async () => {
  const store = createOperationalEventStore('');
  assert.equal(store.configured, false);
  await assert.rejects(() => store.append({ id: 'event-1' }), { code: 'event_store_not_configured' });
  await assert.rejects(() => store.list({ organizationId: 'org-1' }), { code: 'event_store_not_configured' });
});

test('persists events, filters organization/site scope and returns newest events first', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spais-events-'));
  try {
    const store = createOperationalEventStore(join(dir, 'events.jsonl'));
    assert.equal(store.configured, true);
    await store.append({ id: 'e1', organizationId: 'org-1', siteId: 'site-1', eventType: 'session.started' });
    await store.append({ id: 'e2', organizationId: 'org-2', siteId: 'site-1', eventType: 'session.started' });
    await store.append({ id: 'e3', organizationId: 'org-1', siteId: 'site-2', eventType: 'session.stopped' });
    await store.append({ id: 'e4', organizationId: 'org-1', siteId: 'site-1', eventType: 'line.crossed' });

    assert.deepEqual((await store.list({ organizationId: 'org-1' })).map(event => event.id), ['e4', 'e3', 'e1']);
    assert.deepEqual((await store.list({ organizationId: 'org-1', siteId: 'site-1' })).map(event => event.id), ['e4', 'e1']);
    assert.deepEqual((await store.list({ organizationId: 'org-2' })).map(event => event.id), ['e2']);
    assert.deepEqual(await store.list({ organizationId: 'org-3' }), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
