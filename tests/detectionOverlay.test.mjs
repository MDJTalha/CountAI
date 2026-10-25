import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDetectionOverlayLabel } from '../src/engine/detectionOverlay.mjs';

test('normal overlay labels identify detections as AI predictions and hide confidence', () => {
  assert.equal(formatDetectionOverlayLabel('person', 0.89), 'AI prediction · person');
  assert.equal(formatDetectionOverlayLabel('person', 0.89, false), 'AI prediction · person');
});

test('diagnostic overlay can show model confidence without implying certainty', () => {
  assert.equal(formatDetectionOverlayLabel('person', 0.89, true), 'AI prediction · person · 89%');
});

test('overlay explicitly distinguishes a detection from a recorded line crossing', () => {
  assert.equal(formatDetectionOverlayLabel('person', 0.89, false, false), 'AI prediction · person');
  assert.equal(formatDetectionOverlayLabel('person', 0.89, false, true), 'AI prediction · person · line crossing recorded');
  assert.equal(formatDetectionOverlayLabel('person', 0.89, true, true), 'AI prediction · person · line crossing recorded · 89%');
});

test('missing or invalid confidence is omitted even in diagnostic mode', () => {
  assert.equal(formatDetectionOverlayLabel('bottle', undefined, true), 'AI prediction · bottle');
  assert.equal(formatDetectionOverlayLabel('bottle', Number.NaN, true), 'AI prediction · bottle');
});

test('confidence is clamped to a percentage display range', () => {
  assert.equal(formatDetectionOverlayLabel('person', 1.5, true), 'AI prediction · person · 100%');
  assert.equal(formatDetectionOverlayLabel('person', -0.5, true), 'AI prediction · person · 0%');
});

test('empty categories receive a safe fallback label', () => {
  assert.equal(formatDetectionOverlayLabel('  ', 0.9), 'AI prediction · unknown object');
});
