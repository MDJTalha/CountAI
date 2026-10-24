export interface TileRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface InferenceSize {
  width: number;
  height: number;
  scale: number;
}

export interface MergeableDetection {
  id: string;
  category: string;
  confidence?: number;
  bbox: [number, number, number, number];
}

export function getInferenceSize(width: number, height: number, maxDimension?: number): InferenceSize;
export function createTileRegions(width: number, height: number, minDimension?: number, minLongestDimension?: number): TileRegion[];
export function intersectionOverUnion(a: [number, number, number, number], b: [number, number, number, number]): number;
export function mergeTiledDetections<T extends MergeableDetection>(detections: T[], iouThreshold?: number): T[];
