import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCrossingEvents } from '../src/engine/countingBenchmark.mjs';

const event = (timestampMs, overrides = {}) => ({
  clipId: 'clip-1', cameraId: 'camera-1', category: 'person',
  direction: 'A-to-B', timestampMs, ...overrides
});

test('benchmark matches crossings one-to-one within the timestamp tolerance', () => {
  const result = evaluateCrossingEvents(
    [event(1000), event(5000)],
    [event(1200), event(4900), event(9000)],
    { toleranceMs: 300 }
  );
  assert.equal(result.truePositives, 2);
  assert.equal(result.falsePositives, 1);
  assert.equal(result.falseNegatives, 0);
  assert.equal(result.precision, 2 / 3);
  assert.equal(result.recall, 1);
  assert.equal(result.f1, 0.8);
  assert.equal(result.meanAbsoluteCountError, 1);
});

test('benchmark does not match the same prediction to two ground-truth events', () => {
  const result = evaluateCrossingEvents([event(1000), event(1100)], [event(1050)], { toleranceMs: 100 });
  assert.equal(result.truePositives, 1);
  assert.equal(result.falseNegatives, 1);
  assert.equal(result.falsePositives, 0);
});

test('augmenting-path matching maximizes valid matches rather than greedily losing one', () => {
  const result = evaluateCrossingEvents(
    [event(1000), event(1100)],
    [event(900), event(1000)],
    { toleranceMs: 100 }
  );
  assert.equal(result.truePositives, 2);
  assert.deepEqual(result.matchedPairs.map(pair => pair.predictionIndex), [0, 1]);
});

test('benchmark treats wrong camera, clip, category, direction and out-of-window events as errors', () => {
  const truth = event(1000);
  const predictions = [
    event(1000, { cameraId: 'camera-2' }),
    event(1000, { clipId: 'clip-2' }),
    event(1000, { category: 'car' }),
    event(1000, { direction: 'B-to-A' }),
    event(2000)
  ];
  const result = evaluateCrossingEvents([truth], predictions, { toleranceMs: 100 });
  assert.equal(result.truePositives, 0);
  assert.equal(result.falsePositives, 5);
  assert.equal(result.falseNegatives, 1);
});

test('benchmark reports per-clip absolute count error and handles empty input', () => {
  const result = evaluateCrossingEvents(
    [event(1000), event(2000, { clipId: 'clip-2' })],
    [event(1000), event(3000), event(4000, { clipId: 'clip-3' })],
    { toleranceMs: 0 }
  );
  assert.deepEqual(result.perClip, [
    { clipId: 'clip-1', groundTruth: 1, predictions: 2, absoluteCountError: 1 },
    { clipId: 'clip-2', groundTruth: 1, predictions: 0, absoluteCountError: 1 },
    { clipId: 'clip-3', groundTruth: 0, predictions: 1, absoluteCountError: 1 }
  ]);
  assert.equal(result.meanAbsoluteCountError, 1);

  const empty = evaluateCrossingEvents([], []);
  assert.equal(empty.truePositives, 0);
  assert.equal(empty.precision, null);
  assert.equal(empty.recall, null);
  assert.equal(empty.f1, 1);
});

test('benchmark rejects invalid tolerances and malformed event records', () => {
  assert.throws(() => evaluateCrossingEvents([], [], { toleranceMs: -1 }), /toleranceMs_must_be_nonnegative_finite/);
  assert.throws(() => evaluateCrossingEvents([{}], []), /ground_truth_invalid_event_0/);
  assert.throws(() => evaluateCrossingEvents([], [{ ...event(1), timestampMs: Infinity }]), /predictions_invalid_event_0/);
});
