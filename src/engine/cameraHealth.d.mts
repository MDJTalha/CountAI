export type CameraHealthStatus = 'idle' | 'starting' | 'healthy' | 'degraded' | 'disconnected' | 'detection-error' | 'paused' | 'stopped';
export interface CameraHealthState {
  status: CameraHealthStatus;
  startedAt: number | null;
  stoppedAt: number | null;
  lastFrameAt: number | null;
  lastVideoTime: number | null;
  lastInferenceAt: number | null;
  inferenceMs: number | null;
  frameTimestamps: number[];
  error: string | null;
  updatedAt: number;
}
export const CAMERA_HEALTH_THRESHOLDS: Readonly<{ staleFrameMs: number; slowInferenceMs: number; fpsWindowMs: number }>;
export function createCameraHealthState(now?: number): CameraHealthState;
export function startCameraHealth(state: CameraHealthState, now?: number): CameraHealthState;
export function recordCameraFrame(state: CameraHealthState, options?: { now?: number; videoTime?: number; readyState?: number; trackState?: 'live' | 'ended' }): CameraHealthState;
export function recordCameraInference(state: CameraHealthState, options?: { now?: number; durationMs?: number; error?: string | null }): CameraHealthState;
export function evaluateCameraHealth(state: CameraHealthState, options?: { now?: number; trackState?: 'live' | 'ended'; paused?: boolean }): CameraHealthState;
export function stopCameraHealth(state: CameraHealthState, now?: number, options?: { status?: CameraHealthStatus; error?: string | null }): CameraHealthState;
export function getCameraHealthMetrics(state: CameraHealthState, now?: number): { fps: number; inferenceMs: number | null; lastFrameAt: number | null; frameAgeMs: number | null; sessionDurationMs: number | null; status: CameraHealthStatus; error: string | null };
