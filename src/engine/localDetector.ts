import * as cocoSsd from '@tensorflow-models/coco-ssd';
import '@tensorflow/tfjs';
import type { Detection, ModelDetector } from '../types/counting';
import { createTileRegions, getInferenceSize, mergeTiledDetections } from './detectionEnhancement.mjs';

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
    // Keep a narrowed, stable model reference after asynchronous loading so
    // strict TypeScript checks cannot treat the model as null.
    const model = this.model;
    if (!model) throw new Error('The local detector did not finish loading. Please retry.');

    const sourceWidth = image instanceof HTMLVideoElement ? image.videoWidth :
      image instanceof HTMLImageElement ? image.naturalWidth : image.width;
    const sourceHeight = image instanceof HTMLVideoElement ? image.videoHeight :
      image instanceof HTMLImageElement ? image.naturalHeight : image.height;
    if (!sourceWidth || !sourceHeight) {
      throw new Error('The image has no readable dimensions. Re-upload it and try again.');
    }

    // Bound model input size: file size alone does not limit decoded pixel count.
    // A very large photo can otherwise make browser inference extremely slow or
    // exhaust graphics memory. Scale predicted boxes back to source-image pixels.
    const inferenceSize = getInferenceSize(sourceWidth, sourceHeight);
    let input: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement = image;
    if (inferenceSize.scale < 1) {
      const canvas = document.createElement('canvas');
      canvas.width = inferenceSize.width;
      canvas.height = inferenceSize.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Could not prepare this photo for analysis. Try a different image or browser.');
      context.drawImage(image, 0, 0, inferenceSize.width, inferenceSize.height);
      input = canvas;
    }

    const predictions = await model.detect(input, 40, minScore);
    const scaleX = sourceWidth / inferenceSize.width;
    const scaleY = sourceHeight / inferenceSize.height;
    return predictions.map(p => ({
      id: `local-${Date.now()}-${this.nextDetectionId++}`,
      category: p.class,
      confidence: p.score,
      bbox: [
        p.bbox[0] * scaleX,
        p.bbox[1] * scaleY,
        p.bbox[2] * scaleX,
        p.bbox[3] * scaleY
      ],
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
