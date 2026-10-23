export const CAMERA_HEALTH_HISTORY_KEY = 'countai.camera-health-history.v1';
export const CAMERA_HEALTH_HISTORY_LIMIT = 12;

export function appendCameraHealthEvent(events, event, limit = CAMERA_HEALTH_HISTORY_LIMIT) {
  if (!Array.isArray(events) || !event || typeof event.status !== 'string' || !Number.isFinite(event.timestamp)) {
    return Array.isArray(events) ? events : [];
  }
  const previous = events[events.length - 1];
  const nextError = event.error == null ? null : String(event.error).slice(0, 200);
  if (previous && previous.status === event.status && (previous.error ?? null) === nextError) return events;
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : CAMERA_HEALTH_HISTORY_LIMIT;
  return [...events, { timestamp: event.timestamp, status: event.status, error: nextError }].slice(-safeLimit);
}

export function loadCameraHealthHistory(storage) {
  try {
    const raw = storage.getItem(CAMERA_HEALTH_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(event =>
        event &&
        typeof event.status === 'string' &&
        Number.isFinite(event.timestamp) &&
        (event.error == null || typeof event.error === 'string')
      )
      .slice(-CAMERA_HEALTH_HISTORY_LIMIT)
      .map(event => ({ timestamp: event.timestamp, status: event.status, error: event.error ?? null }));
  } catch {
    return [];
  }
}

export function saveCameraHealthHistory(storage, events) {
  try {
    storage.setItem(CAMERA_HEALTH_HISTORY_KEY, JSON.stringify(events.slice(-CAMERA_HEALTH_HISTORY_LIMIT)));
    return true;
  } catch {
    return false;
  }
}
