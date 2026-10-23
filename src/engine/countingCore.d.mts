import type { Box, Detection } from '../types/counting';
export function totalsByCategory(detections: Detection[]): Record<string, number>;
export function intersectionOverUnion(a: Box, b: Box): number;
export interface Track { id: number; category: string; bbox: Box; lastSeen: number; counted: boolean; previousCenter: [number, number]; }
export interface TrackerState { tracks: Track[]; nextId: number; countedIds: Set<number>; }
export function createTracker(): TrackerState;
export function updateTracks(state: TrackerState, detections: Detection[], now?: number, maxAgeMs?: number): TrackerState;
export function countLineCrossings(state: TrackerState, line: [[number,number],[number,number]]): number[];
export interface CrossingEvent {
  trackId: number;
  direction: 'A-to-B' | 'B-to-A';
  category: string;
}

export function countCrossingEvents(
  state: TrackerState,
  line: [[number, number], [number, number]],
  now?: number,
  deadbandPx?: number,
  cooldownMs?: number
): CrossingEvent[];
