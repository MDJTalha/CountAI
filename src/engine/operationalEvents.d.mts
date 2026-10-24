export type OperationalEventType =
  | 'live_session_started'
  | 'live_session_stopped'
  | 'crossing_counted'
  | 'camera_health_changed'
  | 'inference_health_changed'
  | 'operator_correction';

export interface OperationalEvent {
  schemaVersion: 1;
  id: string;
  type: OperationalEventType;
  occurredAt: string;
  sessionId: string;
  actorType: 'system' | 'operator';
  payload: Record<string, unknown>;
}

export function validateOperationalEvent(event: unknown): {
  valid: boolean;
  errors: string[];
};

export function createOperationalEvent(input: Omit<OperationalEvent, 'schemaVersion'> & {
  schemaVersion?: 1;
}): OperationalEvent;

export const OPERATIONAL_EVENT_TYPES: readonly OperationalEventType[];
