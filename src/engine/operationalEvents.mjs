const EVENT_TYPES = new Set([
  'live_session_started',
  'live_session_stopped',
  'crossing_counted',
  'camera_health_changed',
  'inference_health_changed',
  'operator_correction'
]);

const isNonEmptyString = value => typeof value === 'string' && value.trim().length > 0;
const isIsoDate = value => typeof value === 'string' && !Number.isNaN(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/.test(value);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate a version-1 operational event before storing/exporting it.
 * This is a schema guard, not an authorization or cryptographic integrity check.
 */
export function validateOperationalEvent(event) {
  if (!isRecord(event)) return { valid: false, errors: ['event must be an object'] };

  const errors = [];
  if (event.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (!isNonEmptyString(event.id)) errors.push('id must be a non-empty string');
  if (!EVENT_TYPES.has(event.type)) errors.push('type is not a supported operational event');
  if (!isIsoDate(event.occurredAt)) errors.push('occurredAt must be an ISO-8601 timestamp');
  if (!isNonEmptyString(event.sessionId)) errors.push('sessionId must be a non-empty string');
  if (!['system', 'operator'].includes(event.actorType)) errors.push('actorType must be system or operator');
  if (!isRecord(event.payload)) errors.push('payload must be an object');

  if (isRecord(event.payload)) {
    switch (event.type) {
      case 'live_session_started':
        if (!isNonEmptyString(event.payload.mode) || event.payload.mode !== 'live') {
          errors.push('live_session_started payload.mode must be live');
        }
        break;
      case 'live_session_stopped':
        if (!isNonEmptyString(event.payload.reason)) errors.push('live_session_stopped payload.reason is required');
        break;
      case 'crossing_counted':
        if (!['A-to-B', 'B-to-A'].includes(event.payload.direction)) {
          errors.push('crossing_counted payload.direction must be A-to-B or B-to-A');
        }
        if (!isNonEmptyString(event.payload.category)) errors.push('crossing_counted payload.category is required');
        if (!Number.isInteger(event.payload.trackId) || event.payload.trackId < 0) {
          errors.push('crossing_counted payload.trackId must be a non-negative integer');
        }
        break;
      case 'camera_health_changed':
      case 'inference_health_changed':
        if (!isNonEmptyString(event.payload.status)) errors.push(event.type + ' payload.status is required');
        break;
      case 'operator_correction':
        if (!['add', 'edit', 'delete'].includes(event.payload.action)) {
          errors.push('operator_correction payload.action must be add, edit, or delete');
        }
        if (event.actorType !== 'operator') errors.push('operator_correction actorType must be operator');
        break;
      default:
        break;
    }
  }

  return { valid: errors.length === 0, errors };
}

export function createOperationalEvent({ id, type, occurredAt = new Date().toISOString(), sessionId, actorType = 'system', payload }) {
  const event = { schemaVersion: 1, id, type, occurredAt, sessionId, actorType, payload };
  const result = validateOperationalEvent(event);
  if (!result.valid) {
    const error = new TypeError('Invalid operational event: ' + result.errors.join('; '));
    error.validationErrors = result.errors;
    throw error;
  }
  return event;
}

export const OPERATIONAL_EVENT_TYPES = Object.freeze([...EVENT_TYPES]);
