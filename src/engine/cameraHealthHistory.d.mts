import type { CameraHealthStatus } from './cameraHealth.mjs';
export interface CameraHealthEvent { timestamp: number; status: string; error: string | null; }
export const CAMERA_HEALTH_HISTORY_KEY: string;
export const CAMERA_HEALTH_HISTORY_LIMIT: number;
export function appendCameraHealthEvent(events: CameraHealthEvent[], event: CameraHealthEvent, limit?: number): CameraHealthEvent[];
export function loadCameraHealthHistory(storage: Pick<Storage, 'getItem'>): CameraHealthEvent[];
export function saveCameraHealthHistory(storage: Pick<Storage, 'setItem'>, events: CameraHealthEvent[]): boolean;
