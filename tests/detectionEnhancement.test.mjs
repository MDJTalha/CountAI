import test from 'node:test';
import assert from 'node:assert/strict';
import { createTileRegions, intersectionOverUnion, mergeTiledDetections } from '../src/engine/detectionEnhancement.mjs';

test('detail scan creates four overlapping crops for sufficiently large images', () => {
  const regions = createTileRegions(1280, 720);
  assert.equal(regions.length, 4);
  assert.deepEqual(regions[0], { x: 0, y: 0, width: 768, height: 432 });
  assert.deepEqual(regions[3], { x: 512, y: 288, width: 768, height: 432 });
});

test('detail scan skips small images to avoid unnecessary inference passes', () => {
  assert.deepEqual(createTileRegions(640, 480), []);
  assert.deepEqual(createTileRegions(800, 700), []);
});

test('IoU handles overlapping and disjoint boxes', () => {
  assert.equal(intersectionOverUnion([0, 0, 10, 10], [0, 0, 10, 10]), 1);
  assert.equal(intersectionOverUnion([0, 0, 10, 10], [20, 20, 10, 10]), 0);
});

test('tiled merge keeps the higher-confidence overlapping same-class box', () => {
  const detections = [
    { id: 'full', category: 'person', confidence: 0.7, bbox: [10, 10, 40, 60] },
    { id: 'tile', category: 'person', confidence: 0.9, bbox: [11, 11, 40, 60] },
    { id: 'other', category: 'bottle', confidence: 0.6, bbox: [10, 10, 40, 60] }
  ];
  const merged = mergeTiledDetections(detections);
  assert.deepEqual(merged.map(d => d.id), ['tile', 'other']);
});

test('tiled merge does not suppress boxes of different classes', () => {
  const detections = [
    { id: 'person', category: 'person', confidence: 0.8, bbox: [0, 0, 50, 50] },
    { id: 'chair', category: 'chair', confidence: 0.7, bbox: [0, 0, 50, 50] }
  ];
  assert.equal(mergeTiledDetections(detections).length, 2);
});
