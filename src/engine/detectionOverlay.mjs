/**
 * Human-readable labels for live model detections.
 * Scores are deliberately opt-in because model confidence is not a calibrated
 * probability that the predicted category is correct.
 */
export function formatDetectionOverlayLabel(category, confidence, showConfidence = false) {
  const safeCategory = typeof category === 'string' && category.trim() ? category.trim() : 'unknown object';
  if (!showConfidence || !Number.isFinite(confidence)) return `AI prediction · ${safeCategory}`;
  return `AI prediction · ${safeCategory} · ${Math.round(Math.max(0, Math.min(1, confidence)) * 100)}%`;
}
