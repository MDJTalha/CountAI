import * as cocoSsd from '@tensorflow-models/coco-ssd';
import '@tensorflow/tfjs';
import type { Detection, ModelDetector } from '../types/counting';

export class CocoSsdDetector implements ModelDetector {
  private model: cocoSsd.ObjectDetection | null = null;
  async load(): Promise<void> {
    if (this.model) return;
    if (!navigator.onLine) throw new Error('Local model weights are not cached. Connect to the internet for first-time model loading.');
    this.model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
  }
  async detect(image: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement): Promise<Detection[]> {
    if (!this.model) await this.load();
    const predictions = await this.model!.detect(image, 40, 0.25);
    return predictions.map((p, i) => ({
      id: `local-${Date.now()}-${i}`, category: p.class, confidence: p.score,
      bbox: [p.bbox[0], p.bbox[1], p.bbox[2], p.bbox[3]], source: 'local'
    }));
  }
}
