export const CAMERA_HEALTH_THRESHOLDS = Object.freeze({
  staleFrameMs: 2500,
  slowInferenceMs: 500,
  fpsWindowMs: 5000
});

export function createCameraHealthState(now = Date.now()) {
  return {
    status: 'idle',
    startedAt: null,
    stoppedAt: null,
    lastFrameAt: null,
    lastVideoTime: null,
    lastInferenceAt: null,
    inferenceMs: null,
    frameTimestamps: [],
    error: null,
    updatedAt: now
  };
}

export function startCameraHealth(state, now = Date.now()) {
  return {
    ...createCameraHealthState(now),
    status: 'starting',
    startedAt: now,
    updatedAt: now
  };
}

export function recordCameraFrame(state, {
  now = Date.now(),
  videoTime,
  readyState = 2,
  trackState = 'live'
} = {}) {
  if (trackState === 'ended') {
    return { ...state, status: 'disconnected', error: 'Camera track ended', updatedAt: now };
  }
  if (readyState < 2 || !Number.isFinite(videoTime)) {
    return { ...state, updatedAt: now };
  }
  // A repeated video timestamp is not a new frame and must not inflate FPS.
  if (state.lastVideoTime === videoTime) return state;

  const frameTimestamps = [...state.frameTimestamps, now]
    .filter(timestamp => now - timestamp <= CAMERA_HEALTH_THRESHOLDS.fpsWindowMs);
  return {
    ...state,
    status: state.inferenceMs !== null && state.inferenceMs > CAMERA_HEALTH_THRESHOLDS.slowInferenceMs
      ? 'degraded'
      : 'healthy',
    lastFrameAt: now,
    lastVideoTime: videoTime,
    frameTimestamps,
    error: null,
    updatedAt: now
  };
}

export function recordCameraInference(state, { now = Date.now(), durationMs, error = null } = {}) {
  if (error) {
    return {
      ...state,
      status: 'detection-error',
      error: String(error),
      lastInferenceAt: now,
      inferenceMs: Number.isFinite(durationMs) ? Math.max(0, durationMs) : state.inferenceMs,
      updatedAt: now
    };
  }
  const inferenceMs = Number.isFinite(durationMs) ? Math.max(0, durationMs) : null;
  return {
    ...state,
    status: inferenceMs !== null && inferenceMs > CAMERA_HEALTH_THRESHOLDS.slowInferenceMs ? 'degraded' : state.status,
    lastInferenceAt: now,
    inferenceMs,
    error: inferenceMs !== null && inferenceMs > CAMERA_HEALTH_THRESHOLDS.slowInferenceMs
      ? 'AI inference is slower than the 500 ms target'
      : null,
    updatedAt: now
  };
}

export function evaluateCameraHealth(state, {
  now = Date.now(),
  trackState = 'live',
  paused = false
} = {}) {
  if (state.status === 'idle' || state.status === 'stopped') return { ...state, updatedAt: now };
  if (trackState === 'ended') {
    return { ...state, status: 'disconnected', error: 'Camera track ended', updatedAt: now };
  }
  if (paused) return { ...state, status: 'paused', updatedAt: now };
  if (state.status === 'detection-error') return { ...state, updatedAt: now };
  if (state.lastFrameAt === null) {
    return {
      ...state,
      status: state.startedAt !== null && now - state.startedAt > CAMERA_HEALTH_THRESHOLDS.staleFrameMs
        ? 'degraded'
        : 'starting',
      error: state.startedAt !== null && now - state.startedAt > CAMERA_HEALTH_THRESHOLDS.staleFrameMs
        ? 'No video frames received yet'
        : null,
      updatedAt: now
    };
  }
  if (now - state.lastFrameAt > CAMERA_HEALTH_THRESHOLDS.staleFrameMs) {
    return { ...state, status: 'degraded', error: 'Video frames have stalled', updatedAt: now };
  }
  if (state.inferenceMs !== null && state.inferenceMs > CAMERA_HEALTH_THRESHOLDS.slowInferenceMs) {
    return { ...state, status: 'degraded', error: 'AI inference is slower than the 500 ms target', updatedAt: now };
  }
  return { ...state, status: 'healthy', error: null, updatedAt: now };
}

export function stopCameraHealth(state, now = Date.now()) {
  return { ...state, status: 'stopped', stoppedAt: state.startedAt === null ? null : now, error: null, updatedAt: now };
}

export function getCameraHealthMetrics(state, now = Date.now()) {
  const timestamps = state.frameTimestamps.filter(timestamp => now - timestamp <= CAMERA_HEALTH_THRESHOLDS.fpsWindowMs);
  let fps = 0;
  if (timestamps.length > 1) {
    const elapsedMs = timestamps[timestamps.length - 1] - timestamps[0];
    if (elapsedMs > 0) fps = (timestamps.length - 1) * 1000 / elapsedMs;
  }
  return {
    fps: Math.round(fps * 10) / 10,
    inferenceMs: state.inferenceMs,
    lastFrameAt: state.lastFrameAt,
    frameAgeMs: state.lastFrameAt === null ? null : Math.max(0, now - state.lastFrameAt),
    sessionDurationMs: state.startedAt === null ? null : Math.max(0, (state.stoppedAt ?? now) - state.startedAt),
    status: state.status,
    error: state.error
  };
}
