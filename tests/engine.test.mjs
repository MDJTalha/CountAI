import test from 'node:test';
import assert from 'node:assert/strict';
import { totalsByCategory, intersectionOverUnion, createTracker, updateTracks, countLineCrossings, countCrossingEvents } from '../src/engine/countingCore.mjs';

test('totals are derived from detection records', () => {
  assert.deepEqual(totalsByCategory([{category:'bottle'},{category:'person'},{category:'bottle'}]), { bottle: 2, person: 1 });
});
test('IoU is 1 for identical boxes and 0 for disjoint boxes', () => {
  assert.equal(intersectionOverUnion([0,0,10,10],[0,0,10,10]), 1);
  assert.equal(intersectionOverUnion([0,0,10,10],[20,20,10,10]), 0);
});
test('tracker maintains ID across overlapping adjacent-frame boxes', () => {
  let state = createTracker();
  const first = [{id:'a',category:'person',bbox:[0,0,20,20],source:'local'}];
  state = updateTracks(state, first, 1000);
  const id = first[0].trackId;
  const second = [{id:'b',category:'person',bbox:[1,0,20,20],source:'local'}];
  state = updateTracks(state, second, 1100);
  assert.equal(second[0].trackId, id);
});
test('line crossing counts a track once', () => {
  const state = createTracker();
  const first = [{id:'a',category:'person',bbox:[40,20,20,20],source:'local'}];
  let next = updateTracks(state, first, 1000);
  const line = [[0,0.5],[1,0.5]];
  // normalized coords in production: this test uses a horizontal line y=30 in same units
  next.tracks[0].previousCenter = [50,20]; next.tracks[0].bbox = [40,40,20,20];
  assert.deepEqual(countLineCrossings(next, [[0,30],[100,30]]), [1]);
  assert.deepEqual(countLineCrossings(next, [[0,30],[100,30]]), []);
});

// Event-based counting: repeated valid crossings in opposite directions.
test('event counter records repeated crossings and their directions', () => {
  const state = createTracker();
  state.tracks = [{
    id: 1,
    category: 'person',
    bbox: [40, 40, 20, 20],
    previousCenter: [50, 20],
    lastSeen: 1000,
    counted: false
  }];

  const line = [[0, 30], [100, 30]];
  const first = countCrossingEvents(state, line, 1000, 5, 1200);
  assert.deepEqual(first.map(e => [e.category, e.direction]), [
    ['person', 'A-to-B']
  ]);

  // Reverse across the line after the cooldown.
  state.tracks[0].previousCenter = [50, 50];
  state.tracks[0].bbox = [40, 0, 20, 20];
  const second = countCrossingEvents(state, line, 2500, 5, 1200);
  assert.deepEqual(second.map(e => [e.category, e.direction]), [
    ['person', 'B-to-A']
  ]);
});

test('event counter suppresses a crossing that stays inside the deadband', () => {
  const state = createTracker();
  state.tracks = [{
    id: 1,
    category: 'car',
    bbox: [40, 27, 20, 6],
    previousCenter: [50, 28],
    lastSeen: 1000,
    counted: false
  }];

  assert.deepEqual(
    countCrossingEvents(state, [[0, 30], [100, 30]], 1000, 5, 1200),
    []
  );
});


test('event counter suppresses rapid recrossing during cooldown', () => {
  const state = createTracker();
  state.tracks = [{
    id: 7,
    category: 'person',
    bbox: [40, 40, 20, 20],
    previousCenter: [50, 20],
    lastSeen: 1000,
    counted: false
  }];

  const line = [[0, 30], [100, 30]];

  // First valid crossing should count.
  assert.equal(countCrossingEvents(state, line, 1000, 5, 1200).length, 1);

  // Reverse direction, but still inside the 1200 ms cooldown.
  state.tracks[0].previousCenter = [50, 40];
  state.tracks[0].bbox = [40, 0, 20, 20];
  assert.deepEqual(countCrossingEvents(state, line, 1500, 5, 1200), []);

  // The same valid reverse crossing is allowed after cooldown.
  assert.equal(countCrossingEvents(state, line, 2300, 5, 1200).length, 1);
});
