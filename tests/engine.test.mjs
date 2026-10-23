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
    counted: false,
    lastStableSide: -1
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

test('event counter detects gradual crossings through the deadband', () => {
  const state = createTracker();
  state.tracks = [{
    id: 8,
    category: 'person',
    bbox: [40, 10, 20, 20],
    previousCenter: [50, 20],
    lastSeen: 1000,
    counted: false
  }];
  const line = [[0, 30], [100, 30]];

  // Establish the initial side above the line.
  assert.deepEqual(countCrossingEvents(state, line, 1000, 5, 1200), []);
  // Normal movement crosses through the deadband over multiple frames.
  state.tracks[0].bbox = [40, 18, 20, 20]; // center y=28, inside deadband
  assert.deepEqual(countCrossingEvents(state, line, 1100, 5, 1200), []);
  state.tracks[0].bbox = [40, 24, 20, 20]; // center y=34, still inside deadband
  assert.deepEqual(countCrossingEvents(state, line, 1200, 5, 1200), []);
  state.tracks[0].bbox = [40, 30, 20, 20]; // center y=40, clearly below
  assert.deepEqual(
    countCrossingEvents(state, line, 1300, 5, 1200).map(e => e.direction),
    ['A-to-B']
  );
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
    counted: false,
    lastStableSide: -1
  }];

  const line = [[0, 30], [100, 30]];

  // First valid crossing should count.
  assert.equal(countCrossingEvents(state, line, 1000, 5, 1200).length, 1);

  // Reverse direction, but still inside the 1200 ms cooldown.
  state.tracks[0].previousCenter = [50, 40];
  state.tracks[0].bbox = [40, 0, 20, 20];
  assert.deepEqual(countCrossingEvents(state, line, 1500, 5, 1200), []);

  // Cross back during cooldown; the stable side updates without counting.
  state.tracks[0].bbox = [40, 40, 20, 20];
  assert.equal(countCrossingEvents(state, line, 1800, 5, 1200).length, 0);
  // Cross in reverse again after cooldown and count the new transition.
  state.tracks[0].bbox = [40, 0, 20, 20];
  assert.equal(countCrossingEvents(state, line, 2300, 5, 1200).length, 1);
});

test('tracker expires tracks that have not been seen within max age', () => {
  let state = createTracker();
  const detections = [{ id: 'first', category: 'person', bbox: [10, 10, 20, 20], source: 'local' }];
  state = updateTracks(state, detections, 1000, 500);
  assert.equal(state.tracks.length, 1);

  state = updateTracks(state, [], 1501, 500);
  assert.equal(state.tracks.length, 0);
});

test('tracker does not assign one existing track to two detections in the same frame', () => {
  let state = createTracker();
  const initial = [{ id: 'seed', category: 'person', bbox: [10, 10, 20, 20], source: 'local' }];
  state = updateTracks(state, initial, 1000);

  const nextFrame = [
    { id: 'left', category: 'person', bbox: [10, 10, 20, 20], source: 'local' },
    { id: 'right', category: 'person', bbox: [10, 10, 20, 20], source: 'local' }
  ];
  state = updateTracks(state, nextFrame, 1100);

  assert.notEqual(nextFrame[0].trackId, nextFrame[1].trackId);
  assert.equal(new Set(nextFrame.map(d => d.trackId)).size, 2);
});

test('tracker does not match detections across different categories', () => {
  let state = createTracker();
  const initial = [{ id: 'person-1', category: 'person', bbox: [10, 10, 20, 20], source: 'local' }];
  state = updateTracks(state, initial, 1000);

  const nextFrame = [{ id: 'car-1', category: 'car', bbox: [10, 10, 20, 20], source: 'local' }];
  state = updateTracks(state, nextFrame, 1100);

  assert.notEqual(nextFrame[0].trackId, initial[0].trackId);
  assert.equal(state.tracks.length, 2);
});

test('IoU safely returns zero for zero-area boxes', () => {
  assert.equal(intersectionOverUnion([0, 0, 0, 10], [0, 0, 10, 10]), 0);
  assert.equal(intersectionOverUnion([0, 0, 10, 10], [0, 0, 0, 0]), 0);
});

