export type Box = [x: number, y: number, width: number, height: number];
export type DetectionSource = 'local' | 'cloud' | 'manual';
export interface Detection {
  id: string; category: string; bbox: Box; confidence?: number; source: DetectionSource;
  trackId?: number; counted?: boolean; color?: string; shape?: string;
}
export interface CountSession {
  id: string; createdAt: string; title: string; mode: 'photo' | 'live'; target: string;
  detections: Detection[]; totals: Record<string, number>; imageDataUrl?: string;
}
export interface ModelDetector { load(): Promise<void>; detect(image: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement): Promise<Detection[]>; }
