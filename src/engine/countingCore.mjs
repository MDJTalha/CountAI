export function totalsByCategory(detections) {
  return detections.reduce((acc, d) => {
    acc[d.category] = (acc[d.category] ?? 0) + 1;
    return acc;
  }, {});
}

export function intersectionOverUnion(a, b) {
  const left = Math.max(a[0], b[0]);
  const top = Math.max(a[1], b[1]);
  const right = Math.min(a[0] + a[2], b[0] + b[2]);
  const bottom = Math.min(a[1] + a[3], b[1] + b[3]);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = a[2] * a[3] + b[2] * b[3] - intersection;
  return union > 0 ? intersection / union : 0;
}

export function createTracker() {
  return { tracks: [], nextId: 1, countedIds: new Set() };
}

const center = b => [b[0] + b[2] / 2, b[1] + b[3] / 2];

function centerDistance(a, b) {
  const ca = center(a);
  const cb = center(b);
  return Math.hypot(ca[0] - cb[0], ca[1] - cb[1]);
}

export function updateTracks(state, detections, now = Date.now(), maxAgeMs = 3000) {
  const live = state.tracks.filter(t => now - t.lastSeen <= maxAgeMs);
  const next = live.map(t => ({
    ...t,
    bbox: [...t.bbox],
    previousCenter: [...t.previousCenter]
  }));
  const used = new Set();

  for (const detection of detections) {
    let best;
    let bestScore = -1;

    for (const track of next) {
      if (used.has(track.id) || track.category !== detection.category) continue;

      const overlap = intersectionOverUnion(track.bbox, detection.bbox);
      const distance = centerDistance(track.bbox, detection.bbox);
      const scale = Math.max(
        40,
        Math.max(
          track.bbox[2], track.bbox[3],
          detection.bbox[2], detection.bbox[3]
        ) * 0.75
      );

      if (overlap < 0.12 && distance > scale) continue;
      const proximity = 1 - Math.min(distance / scale, 1);
      const score = overlap * 0.65 + proximity * 0.35;

      if (score > bestScore) {
        bestScore = score;
        best = track;
      }
    }

    if (best) {
      best.previousCenter = center(best.bbox);
      const smoothingAlpha = 0.25;
      best.bbox = best.bbox.map((previous, index) =>
        previous * (1 - smoothingAlpha) + detection.bbox[index] * smoothingAlpha
      );
      detection.bbox = [...best.bbox];
      best.lastSeen = now;
      best.hits = (best.hits ?? 1) + 1;
      used.add(best.id);
      detection.trackId = best.id;
      detection.counted = best.counted;
    } else {
      const track = {
        id: state.nextId++,
        category: detection.category,
        bbox: [...detection.bbox],
        lastSeen: now,
        hits: 1,
        counted: false,
        previousCenter: center(detection.bbox)
      };

      next.push(track);
      used.add(track.id);
      detection.trackId = track.id;
      detection.counted = false;
    }
  }

  return { ...state, tracks: next };
}

function signedDistanceFromLine(point, line) {
  const [a, b] = line;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy) || 1;
  return (dx * (point[1] - a[1]) - dy * (point[0] - a[0])) / length;
}

/*
 * New event-based counter:
 * - permits a track to cross in either direction more than once;
 * - requires the centre to clear a deadband on both sides;
 * - applies a per-track cooldown to suppress line jitter.
 */
export function countCrossingEvents(
  state,
  line,
  now = Date.now(),
  deadbandPx = 12,
  cooldownMs = 1200
) {
  const events = [];

  for (const track of state.tracks) {
    if (!track.bbox) continue;

    // Remember the last side the object clearly occupied. A frame-by-frame
    // sign change misses normal slow crossings because intermediate frames
    // fall inside the deadband. Stable-side transitions handle those frames.
    const currentDistance = signedDistanceFromLine(center(track.bbox), line);
    if (Math.abs(currentDistance) < deadbandPx) continue;
    const currentSide = Math.sign(currentDistance);

    if (track.lastStableSide === undefined || track.lastStableSide === 0) {
      track.lastStableSide = currentSide;
      continue;
    }
    if (track.lastStableSide === currentSide) continue;

    const previousSide = track.lastStableSide;
    track.lastStableSide = currentSide;
    if (now - (track.lastCrossingAt ?? -Infinity) < cooldownMs) continue;

    const direction = previousSide < currentSide ? 'A-to-B' : 'B-to-A';
    track.lastCrossingAt = now;
    track.crossingDirection = direction;
    track.counted = true;
    state.countedIds.add(track.id);

    events.push({ trackId: track.id, direction, category: track.category });
  }

  return events;
}

/* Kept for compatibility with the existing engine tests and callers. */
export function countLineCrossings(state, line) {
  const newlyCounted = [];

  for (const track of state.tracks) {
    if (track.counted) continue;

    const current = center(track.bbox);
    const beforeSide = side(track.previousCenter, line);
    const currentSide = side(current, line);

    if (beforeSide !== 0 && currentSide !== 0 && beforeSide !== currentSide) {
      track.counted = true;
      track.crossingDirection = beforeSide < currentSide ? 'A-to-B' : 'B-to-A';
      state.countedIds.add(track.id);
      newlyCounted.push(track.id);
    }
  }

  return newlyCounted;
}

function side(p, line) {
  const value =
    (line[1][0] - line[0][0]) * (p[1] - line[0][1]) -
    (line[1][1] - line[0][1]) * (p[0] - line[0][0]);

  return Math.abs(value) < 0.0005 ? 0 : Math.sign(value);
}
