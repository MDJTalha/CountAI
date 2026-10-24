import * as cocoSsd from '@tensorflow-models/coco-ssd';
import '@tensorflow/tfjs';
import type { Detection, ModelDetector } from '../types/counting';
import { createTileRegions, mergeTiledDetections } from './detectionEnhancement.mjs';

export class CocoSsdDetector implements ModelDetector {
  private model: cocoSsd.ObjectDetection | null = null;
  private nextDetectionId = 1;

  async load(): Promise<void> {
    if (this.model) return;
    if (!navigator.onLine) throw new Error('Local model weights are not cached. Connect to the internet for first-time model loading.');
    this.model = await cocoSsd.load({ base: 'lite_mobilenet_v2' });
  }

  private async detectSource(image: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement, minScore = 0.25): Promise<Detection[]> {
    if (!this.model) await this.load();
    const predictions = await this.model!.detect(image, 40, minScore);
    return predictions.map(p => ({
      id: `local-${Date.now()}-${this.nextDetectionId++}`,
      category: p.class,
      confidence: p.score,
      bbox: [p.bbox[0], p.bbox[1], p.bbox[2], p.bbox[3]],
      source: 'local'
    }));
  }

  async detect(image: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement): Promise<Detection[]> {
    return this.detectSource(image);
  }

  /**
   * Photo-only recall enhancement: run the normal full-image pass, then four
   * overlapping crops for supported objects that occupy too few pixels in the
   * full image. This costs extra inference time and cannot add classes outside
   * the COCO-SSD label set. Overlapping duplicate boxes are merged afterward.
   */
  async detectDetailed(image: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement): Promise<Detection[]> {
    const fullImageResults = await this.detectSource(image);
    const width = image instanceof HTMLVideoElement ? image.videoWidth :
      image instanceof HTMLImageElement ? image.naturalWidth : image.width;
    const height = image instanceof HTMLVideoElement ? image.videoHeight :
      image instanceof HTMLImageElement ? image.naturalHeight : image.height;
    const regions = createTileRegions(width, height);
    if (!regions.length) return fullImageResults;

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) return fullImageResults;

    const tiledResults: Detection[] = [];
    for (const region of regions) {
      canvas.width = region.width;
      canvas.height = region.height;
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height);
      // Slightly lower score threshold on crops improves recall; duplicate
      // suppression and human review remain important for precision.
      const cropResults = await this.detectSource(canvas, 0.20);
      for (const detection of cropResults) {
        detection.bbox = [
          detection.bbox[0] + region.x,
          detection.bbox[1] + region.y,
          detection.bbox[2],
          detection.bbox[3]
        ];
        tiledResults.push(detection);
      }
    }

    return mergeTiledDetections([...fullImageResults, ...tiledResults]);
  }
}
