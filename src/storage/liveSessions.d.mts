export interface LiveSessionRecord {
  id: string;
  startedAt: string;
  endedAt: string | null;
  status: 'running' | 'stopped';
  stopReason: string | null;
  mode: 'live';
  requestedResolution?: string;
  actualResolution?: string;
  linePosition?: number;
  detectionMode?: string;
  totalCrossings: number;
  totals: Record<string, number>;
  directions: Record<'A-to-B' | 'B-to-A', number>;
  cameraHealth: string;
  inferenceHealth: string;
  events: Array<Record<string, unknown>>;
  eventCount: number;
  droppedEventCount: number;
  lastEventAt: string;
}
export const LIVE_SESSIONS_KEY: string;
export function startLiveSession(storage: Storage, options: {
  id?: string; startedAt?: string; requestedResolution?: string; actualResolution?: string;
  linePosition?: number; detectionMode?: string;
}): LiveSessionRecord;
export function appendLiveSessionEvent(storage: Storage, sessionId: string, event: unknown): boolean;
export function recordLiveSessionEvent(storage: Storage, sessionId: string, type: string, payload: Record<string, unknown>, actorType?: 'system' | 'operator', occurredAt?: string): boolean;
export function finishLiveSession(storage: Storage, sessionId: string, options?: {
  endedAt?: string; reason?: string; actualResolution?: string; linePosition?: number;
  detectionMode?: string; totals?: Record<string, number>;
  directions?: Record<'A-to-B' | 'B-to-A', number>; totalCrossings?: number;
}): LiveSessionRecord | false;
export function listLiveSessions(storage: Storage): LiveSessionRecord[];
export function deleteLiveSession(storage: Storage, sessionId: string): boolean;
