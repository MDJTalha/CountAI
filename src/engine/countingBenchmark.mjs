const DIRECTIONS = new Set(['A-to-B', 'B-to-A']);

function validateEvents(events, label) {
  if (!Array.isArray(events)) throw new TypeError(label + '_must_be_array');
  return events.map((event, index) => {
    if (!event || typeof event !== 'object' || Array.isArray(event) ||
        typeof event.clipId !== 'string' || !event.clipId.trim() ||
        typeof event.cameraId !== 'string' || !event.cameraId.trim() ||
        typeof event.category !== 'string' || !event.category.trim() ||
        !DIRECTIONS.has(event.direction) ||
        !Number.isFinite(event.timestampMs) || event.timestampMs < 0) {
      throw new TypeError(label + '_invalid_event_' + index);
    }
    return { ...event, _index: index };
  });
}

/**
 * Evaluate predicted crossing events against human-reviewed ground truth.
 * Matching is one-to-one and constrained by clip, camera, category, direction,
 * and timestamp tolerance. The evaluator never tunes thresholds or labels data.
 */
export function evaluateCrossingEvents(groundTruthInput, predictionsInput, { toleranceMs = 1000 } = {}) {
  if (!Number.isFinite(toleranceMs) || toleranceMs < 0) {
    throw new RangeError('toleranceMs_must_be_nonnegative_finite');
  }
  const groundTruth = validateEvents(groundTruthInput, 'ground_truth');
  const predictions = validateEvents(predictionsInput, 'predictions');
  const candidates = groundTruth.map((truth, truthIndex) => ({
    truthIndex,
    matches: predictions
      .map((prediction, predictionIndex) => ({
        predictionIndex,
        delta: Math.abs(truth.timestampMs - prediction.timestampMs),
        prediction
      }))
      .filter(({ delta, prediction }) =>
        delta <= toleranceMs &&
        prediction.clipId === truth.clipId &&
        prediction.cameraId === truth.cameraId &&
        prediction.category === truth.category &&
        prediction.direction === truth.direction
      )
      .sort((a, b) => a.delta - b.delta ||
        a.prediction.timestampMs - b.prediction.timestampMs ||
        a.predictionIndex - b.predictionIndex)
  }));

  // Augmenting paths guarantee a maximum-cardinality one-to-one matching;
  // a greedy nearest-neighbor pass can otherwise lose a valid match.
  const predictionToTruth = new Map();
  function assign(truthIndex, visited) {
    for (const candidate of candidates[truthIndex].matches) {
      if (visited.has(candidate.predictionIndex)) continue;
      visited.add(candidate.predictionIndex);
      const previousTruth = predictionToTruth.get(candidate.predictionIndex);
      if (previousTruth === undefined || assign(previousTruth, visited)) {
        predictionToTruth.set(candidate.predictionIndex, truthIndex);
        return true;
      }
    }
    return false;
  }
  for (const candidate of candidates) assign(candidate.truthIndex, new Set());

  const truthToPrediction = new Map();
  for (const [predictionIndex, truthIndex] of predictionToTruth) {
    truthToPrediction.set(truthIndex, predictionIndex);
  }
  const matchedPairs = [...truthToPrediction.entries()]
    .map(([truthIndex, predictionIndex]) => ({
      groundTruthIndex: groundTruth[truthIndex]._index,
      predictionIndex: predictions[predictionIndex]._index,
      deltaMs: Math.abs(groundTruth[truthIndex].timestampMs - predictions[predictionIndex].timestampMs),
      clipId: groundTruth[truthIndex].clipId,
      cameraId: groundTruth[truthIndex].cameraId,
      category: groundTruth[truthIndex].category,
      direction: groundTruth[truthIndex].direction
    }))
    .sort((a, b) => a.groundTruthIndex - b.groundTruthIndex);
  const truePositives = matchedPairs.length;
  const falseNegatives = groundTruth.length - truePositives;
  const falsePositives = predictions.length - truePositives;
  const precision = predictions.length ? truePositives / predictions.length : null;
  const recall = groundTruth.length ? truePositives / groundTruth.length : null;
  const f1 = precision === null || recall === null
    ? (truePositives === 0 && groundTruth.length === 0 && predictions.length === 0 ? 1 : 0)
    : (precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall));

  const clipIds = [...new Set([...groundTruth, ...predictions].map(event => event.clipId))].sort();
  const perClip = clipIds.map(clipId => {
    const expected = groundTruth.filter(event => event.clipId === clipId).length;
    const predicted = predictions.filter(event => event.clipId === clipId).length;
    return { clipId, groundTruth: expected, predictions: predicted, absoluteCountError: Math.abs(predicted - expected) };
  });
  const meanAbsoluteCountError = perClip.length
    ? perClip.reduce((sum, item) => sum + item.absoluteCountError, 0) / perClip.length
    : 0;

  return {
    toleranceMs,
    groundTruthCount: groundTruth.length,
    predictionCount: predictions.length,
    truePositives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    f1,
    meanAbsoluteCountError,
    matchedPairs,
    perClip
  };
}
