import type { Detection } from '../types/counting';

/** Optional backend adapter. The browser never receives provider API credentials. */
export async function recognizeWithCloud(image: Blob, prompt: string, endpoint = '/api/recognize'): Promise<Detection[]> {
  const body = new FormData(); body.append('image', image, 'countai-upload.jpg'); body.append('prompt', prompt);
  const response = await fetch(endpoint, { method: 'POST', body });
  if (!response.ok) throw new Error(`Cloud recognition failed (${response.status}).`);
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== 'object' || !('detections' in payload) || !Array.isArray((payload as {detections: unknown}).detections)) {
    throw new Error('Cloud service returned an invalid detection payload.');
  }
  return (payload as {detections: Detection[]}).detections.map((d, i) => validateCloudDetection(d, i));
}
function validateCloudDetection(value: unknown, i: number): Detection {
  if (!value || typeof value !== 'object') throw new Error('Invalid cloud detection.');
  const d = value as Partial<Detection>;
  if (typeof d.category !== 'string' || !Array.isArray(d.bbox) || d.bbox.length !== 4 || !d.bbox.every(Number.isFinite)) throw new Error('Cloud detection missing valid category or bounding box.');
  const [x, y, w, h] = d.bbox;
  if (x! < 0 || y! < 0 || w! <= 0 || h! <= 0) throw new Error('Cloud detection contains invalid box coordinates.');
  return { id: `cloud-${Date.now()}-${i}`, category: d.category.slice(0, 100), bbox: [x!, y!, w!, h!], confidence: typeof d.confidence === 'number' ? Math.max(0, Math.min(1, d.confidence)) : undefined, source: 'cloud' };
}
