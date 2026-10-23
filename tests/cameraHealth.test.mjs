import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCameraHealthState,
  startCameraHealth,
  recordCameraFrame,
  recordCameraInference,
  evaluateCameraHealth,
  stopCameraHealth,
  getCameraHealthMetrics
} from '../src/engine/cameraHealth.mjs';

test('camera health starts in a starting state and transitions healthy on a new frame', () => {
  let state = startCameraHealth(createCameraHealthState(0), 100);
  assert.equal(state.status, 'starting');
  state = recordCameraFrame(state, { now: 120, videoTime: 0.04, readyState: 2 });
  assert.equal(state.status, 'healthy');
  assert.equal(state.lastFrameAt, 120);
});

test('repeated video timestamps do not inflate FPS or refresh frame age', () => {
  let state = startCameraHealth(createCameraHealthState(0), 0);
  state = recordCameraFrame(state, { now: 100, videoTime: 1 });
  const repeated = recordCameraFrame(state, { now: 200, videoTime: 1 });
  assert.equal(repeated.lastFrameAt, 100);
  assert.equal(repeated.frameTimestamps.length, 1);
});

test('frame watchdog marks a stalled stream degraded', () => {
  let state = startCameraHealth(createCameraHealthState(0), 0);
  state = recordCameraFrame(state, { now: 100, videoTime: 1 });
  state = evaluateCameraHealth(state, { now: 2701, trackState: 'live' });
  assert.equal(state.status, 'degraded');
  assert.match(state.error, /stalled/i);
});

test('ended camera track is reported as disconnected', () => {
  let state = startCameraHealth(createCameraHealthState(0), 0);
  state = evaluateCameraHealth(state, { now: 50, trackState: 'ended' });
  assert.equal(state.status, 'disconnected');
});

test('slow inference is reported as degraded and latency is retained', () => {
  let state = startCameraHealth(createCameraHealthState(0), 0);
  state = recordCameraFrame(state, { now: 100, videoTime: 1 });
  state = recordCameraInference(state, { now: 650, durationMs: 550 });
  assert.equal(state.status, 'degraded');
  assert.equal(state.inferenceMs, 550);
  assert.match(state.error, /slower/i);
});

test('inference failures are distinguished from an empty scene', () => {
  let state = startCameraHealth(createCameraHealthState(0), 0);
  state = recordCameraFrame(state, { now: 100, videoTime: 1 });
  state = recordCameraInference(state, { now: 150, durationMs: 50, error: 'model unavailable' });
  assert.equal(state.status, 'detection-error');
  assert.match(state.error, /model unavailable/);
});

test('FPS uses unique recent frames and stale frame age is exposed', () => {
  let state = startCameraHealth(createCameraHealthState(0), 0);
  state = recordCameraFrame(state, { now: 100, videoTime: 1 });
  state = recordCameraFrame(state, { now: 200, videoTime: 1.1 });
  state = recordCameraFrame(state, { now: 300, videoTime: 1.2 });
  const metrics = getCameraHealthMetrics(state, 400);
  assert.equal(metrics.fps, 10);
  assert.equal(metrics.frameAgeMs, 100);
});

test('stopped camera stays stopped when evaluated', () => {
  let state = stopCameraHealth(startCameraHealth(createCameraHealthState(0), 0), 100);
  state = evaluateCameraHealth(state, { now: 1000, trackState: 'ended' });
  assert.equal(state.status, 'stopped');
});
