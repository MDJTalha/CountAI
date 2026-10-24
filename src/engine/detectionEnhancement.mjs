export function getInferenceSize(width, height, maxDimension = 1280) {
  if (![width, height, maxDimension].every(Number.isFinite) || width <= 0 || height <= 0 || maxDimension <= 0) {
    throw new RangeError('Image dimensions and maximum inference dimension must be positive finite numbers.');
  }
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale
  };
}

export function createTileRegions(width, height, minDimension = 480, minLongestDimension = 900) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return [];
  if (Math.min(width, height) < minDimension || Math.max(width, height) < minLongestDimension) return [];

  // Four overlapping 60% crops make smaller supported objects occupy more of
  // the detector input. The overlap helps objects near crop boundaries.
  const tileWidth = Math.ceil(width * 0.6);
  const tileHeight = Math.ceil(height * 0.6);
  const xs = [...new Set([0, Math.max(0, width - tileWidth)])];
  const ys = [...new Set([0, Math.max(0, height - tileHeight)])];
  return ys.flatMap(y => xs.map(x => ({
    x, y,
    width: Math.min(tileWidth, width - x),
    height: Math.min(tileHeight, height - y)
  })));
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

export function mergeTiledDetections(detections, iouThreshold = 0.5) {
  const ranked = [...detections].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  const kept = [];
  for (const candidate of ranked) {
    const duplicate = kept.some(existing =>
      existing.category.toLowerCase() === candidate.category.toLowerCase() &&
      intersectionOverUnion(existing.bbox, candidate.bbox) >= iouThreshold
    );
    if (!duplicate) kept.push(candidate);
  }
  return kept;
}
