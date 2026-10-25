import { createServer } from 'node:http';
import { applySecurityHeaders, createApiRateLimiter, getClientRateLimitKey } from './securityControls.mjs';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize } from 'node:path';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { getSpaisContractManifest, authorizeSpaisAction, isResourceId } from './spais/contracts.mjs';
import { verifySpaisBearerTokenAsync } from './spais/authOidc.mjs';
import { createSqliteSpaisResourceStore, validateSpaisResourceInput, validateSpaisResourcePatch } from './spais/resources.mjs';
import { createConnectorTelemetryReceiver } from './spais/connectorTelemetry.mjs';
import { evaluateRecordingCoverageReports, validateRecordingAssuranceQuery } from './spais/recordingAssurance.mjs';
import { createSqliteIncidentStore, validateIncidentInput, validateIncidentTransition } from './spais/incidents.mjs';
import { createSqliteSopStore, validateSopInput, validateSopTransition } from './spais/sops.mjs';
import { createSqliteLearningCandidateStore, validateLearningCandidateInput, validateLearningCandidateTransition } from './spais/learningCandidates.mjs';
import { getTrustedLearningEvaluatorConfig, validateLearningEvaluationReport, verifyLearningEvaluationAttestation } from './spais/learningEvaluations.mjs';
import { createSqliteLearningSourceStore } from './spais/learningSources.mjs';
import {
  createOperationalEvent,
  createOperationalEventStore,
  createSqliteOperationalEventStore,
  validateOperationalEvent
} from './spais/operationalEvents.mjs';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
function positiveIntegerSetting(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}
const port = positiveIntegerSetting('PORT', 8787);
const apiRateLimiter = createApiRateLimiter({
  windowMs: positiveIntegerSetting('COUNTAI_RATE_LIMIT_WINDOW_MS', 60_000),
  apiLimit: positiveIntegerSetting('COUNTAI_API_RATE_LIMIT', 120),
  writeLimit: positiveIntegerSetting('COUNTAI_WRITE_RATE_LIMIT', 30)
});
const hstsEnabled = process.env.COUNTAI_ENABLE_HSTS === 'true';
const operationalEventStore = process.env.SPAIS_EVENTS_DB_PATH
  ? createSqliteOperationalEventStore(process.env.SPAIS_EVENTS_DB_PATH)
  : createOperationalEventStore();
const resourceStore = createSqliteSpaisResourceStore(process.env.SPAIS_EVENTS_DB_PATH);
const connectorTelemetryReceiver = createConnectorTelemetryReceiver({
  databasePath: process.env.SPAIS_EVENTS_DB_PATH,
  resourceStore
});
const incidentStore = createSqliteIncidentStore(process.env.SPAIS_EVENTS_DB_PATH);
const sopStore = createSqliteSopStore(process.env.SPAIS_EVENTS_DB_PATH);
const learningCandidateStore = createSqliteLearningCandidateStore(process.env.SPAIS_EVENTS_DB_PATH);
const learningSourceStore = createSqliteLearningSourceStore({ databasePath: process.env.SPAIS_EVENTS_DB_PATH });
const spaisAuthConfigured = Boolean(
  (process.env.SPAIS_AUTH_JWKS_URL || process.env.SPAIS_AUTH_HS256_SECRET) &&
  process.env.SPAIS_AUTH_ISSUER && process.env.SPAIS_AUTH_AUDIENCE
);
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.webmanifest':'application/manifest+json', '.png':'image/png', '.ico':'image/x-icon' };
function staticCacheControl(file) {
  const name = file.slice(file.lastIndexOf('/') + 1);
  // Vite's content-hashed assets are immutable; entry HTML, service worker,
  // manifest and unhashed public files must revalidate after a deployment.
  return /[-.][A-Za-z0-9_-]{8,}\.(?:js|css|woff2?|png|svg)$/i.test(name)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
}
function json(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders
  });
  return res.end(JSON.stringify(body));
}
async function readJsonBody(req, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error('request_body_too_large');
      error.code = 'request_body_too_large';
      throw error;
    }
    chunks.push(chunk);
  }
  if (size === 0) {
    const error = new Error('json_body_required');
    error.code = 'json_body_required';
    throw error;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('invalid_json');
    error.code = 'invalid_json';
    throw error;
  }
}
async function authorizeEventRequest(req, organizationId, siteId, action) {
  const authentication = await verifySpaisBearerTokenAsync(req.headers.authorization);
  if (!authentication.authenticated) {
    return { status: 401, body: { error: 'unauthorized', reason: authentication.reason }, headers: { 'www-authenticate': 'Bearer' } };
  }
  const authorization = authorizeSpaisAction({
    principal: authentication.principal,
    organizationId,
    ...(siteId ? { siteId } : {}),
    action
  });
  if (!authorization.allowed) {
    return { status: 403, body: { error: 'forbidden', reason: authorization.reason } };
  }
  return { principal: authentication.principal };
}
const server = createServer(async (req, res) => {
  applySecurityHeaders(res, { enableHsts: hstsEnabled });
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  // Health probes remain available to load balancers. All other API routes are
  // bounded per socket peer; write-heavy requests use a stricter separate budget.
  if (url.pathname.startsWith('/api/') && url.pathname !== '/api/health') {
    const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method || 'GET');
    const rate = apiRateLimiter.check({ key: getClientRateLimitKey(req), isWrite });
    res.setHeader('x-ratelimit-limit', String(rate.limit));
    res.setHeader('x-ratelimit-remaining', String(rate.remaining));
    res.setHeader('x-ratelimit-reset', String(Math.ceil(rate.resetAt / 1000)));
    if (!rate.allowed) {
      res.setHeader('retry-after', String(rate.retryAfterSeconds));
      return json(res, 429, { error: 'rate_limit_exceeded', retryAfterSeconds: rate.retryAfterSeconds });
    }
  }
  if (url.pathname === '/api/health') return json(res, 200, {ok:true, service:'countai-api', cloudRecognitionConfigured:false});
  if (url.pathname === '/api/v1/spais/contracts' && req.method === 'GET') {
    return json(res, 200, getSpaisContractManifest({
      authenticationConfigured: spaisAuthConfigured,
      tenantResourceApiEnabled: spaisAuthConfigured && resourceStore.configured
    }));
  }

  // Operators can read recent telemetry only for an authorized organization/site/connector.
  const connectorTelemetryReadRoute = url.pathname.match(/^\/api\/v1\/organizations\/([^/]+)\/connectors\/([^/]+)\/telemetry$/);
  if (connectorTelemetryReadRoute) {
    if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' }, { allow: 'GET' });
    let organizationId;
    let connectorId;
    try {
      organizationId = decodeURIComponent(connectorTelemetryReadRoute[1]);
      connectorId = decodeURIComponent(connectorTelemetryReadRoute[2]);
    } catch { return json(res, 400, { error: 'invalid_resource_id' }); }
    const siteId = url.searchParams.get('siteId') || undefined;
    if (!isResourceId(organizationId) || !isResourceId(connectorId)) return json(res, 400, { error: 'invalid_resource_id' });
    if (!isResourceId(siteId)) return json(res, 400, { error: 'site_id_required' });
    if (!spaisAuthConfigured || !resourceStore.configured || !connectorTelemetryReceiver.configured) {
      return json(res, 503, { error: 'connector_telemetry_not_enabled' });
    }
    const authentication = await verifySpaisBearerTokenAsync(req.headers.authorization);
    if (!authentication.authenticated) {
      return json(res, 401, { error: 'unauthorized', reason: authentication.reason }, { 'www-authenticate': 'Bearer' });
    }
    const authorization = authorizeSpaisAction({
      principal: authentication.principal, organizationId, siteId, action: 'connector:read'
    });
    if (!authorization.allowed) return json(res, 403, { error: 'forbidden', reason: authorization.reason });
    try {
      const connector = await resourceStore.get({ organizationId, resourceType: 'connector', resourceId: connectorId, siteId });
      if (!connector || connector.status !== 'enrolled') return json(res, 404, { error: 'connector_not_found' });
      const requestedLimit = Number(url.searchParams.get('limit') || 100);
      const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(100, requestedLimit)) : 100;
      const telemetry = await connectorTelemetryReceiver.list({ organizationId, siteId, connectorId, limit });
      return json(res, 200, { organizationId, siteId, connectorId, telemetry, count: telemetry.length, limit });
    } catch (error) {
      if (error.code === 'invalid_telemetry_query') return json(res, 400, { error: error.code });
      console.error('SPAIS connector telemetry read failed:', error?.code || error?.name || 'unknown_error');
      return json(res, 500, { error: 'connector_telemetry_read_failed' });
    }
  }

  // Connector telemetry is authenticated by the enrolled connector's RSA key.
  // These signed reports are not treated as independently verified recorder evidence.
  const connectorTelemetryRoute = url.pathname.match(/^\/api\/v1\/connectors\/([^/]+)\/telemetry$/);
  if (connectorTelemetryRoute) {
    if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
    let connectorId;
    try { connectorId = decodeURIComponent(connectorTelemetryRoute[1]); }
    catch { return json(res, 400, { error: 'invalid_connector_id' }); }
    if (!isResourceId(connectorId)) return json(res, 400, { error: 'invalid_connector_id' });
    if (!resourceStore.configured || !connectorTelemetryReceiver.configured) {
      return json(res, 503, { error: 'connector_telemetry_not_enabled' });
    }
    let input;
    try { input = await readJsonBody(req, 16 * 1024); }
    catch (error) {
      const status = error.code === 'request_body_too_large' ? 413 : 400;
      return json(res, status, { error: error.code || 'invalid_request_body' });
    }
    const allowedFields = new Set([
      'organizationId', 'siteId', 'connectorId', 'timestamp', 'nonce', 'deliveryId', 'eventType', 'payload', 'signature'
    ]);
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => !allowedFields.has(key)) || input.connectorId !== connectorId) {
      return json(res, 400, { error: 'invalid_telemetry_envelope' });
    }
    try {
      const receipt = await connectorTelemetryReceiver.accept(input);
      return json(res, 202, { receipt });
    } catch (error) {
      if (error.code === 'invalid_telemetry_envelope' || error.code === 'invalid_telemetry_payload') {
        return json(res, 400, { error: error.code });
      }
      if (error.code === 'telemetry_timestamp_out_of_window') return json(res, 401, { error: error.code });
      if (error.code === 'connector_identity_not_active') return json(res, 401, { error: error.code });
      if (error.code === 'telemetry_camera_scope_mismatch') return json(res, 403, { error: error.code });
      if (error.code === 'invalid_telemetry_signature') return json(res, 401, { error: error.code });
      if (error.code === 'telemetry_replay_detected') return json(res, 409, { error: error.code });
      if (error.code === 'telemetry_delivery_id_conflict') return json(res, 409, { error: error.code });
      console.error('SPAIS connector telemetry failed:', error?.code || error?.name || 'unknown_error');
      return json(res, 500, { error: 'connector_telemetry_failed' });
    }
  }

  // Operational events are tenant-scoped. The organization comes from the URL,
  // while actor identity and permission scope come only from a verified bearer token.
  const eventRoute = url.pathname.match(/^\/api\/v1\/organizations\/([^/]+)\/events$/);
  if (eventRoute) {
    if (req.method !== 'GET' && req.method !== 'POST') {
      return json(res, 405, { error: 'method_not_allowed' }, { allow: 'GET, POST' });
    }
    let organizationId;
    try { organizationId = decodeURIComponent(eventRoute[1]); }
    catch { return json(res, 400, { error: 'invalid_organization_id' }); }
    if (!isResourceId(organizationId)) return json(res, 400, { error: 'invalid_organization_id' });

    let input;
    let siteId = url.searchParams.get('siteId') || undefined;
    if (req.method === 'POST') {
      try { input = await readJsonBody(req); }
      catch (error) {
        const status = error.code === 'request_body_too_large' ? 413 : 400;
        return json(res, status, { error: error.code || 'invalid_request_body' });
      }
      const validation = validateOperationalEvent(input);
      if (!validation.valid) return json(res, 400, { error: 'invalid_operational_event', details: validation.errors });
      siteId = input.siteId || undefined;
    }
    if (siteId && !isResourceId(siteId)) return json(res, 400, { error: 'invalid_site_id' });

    const action = req.method === 'GET' ? 'session:read' : 'session:manage';
    const access = await authorizeEventRequest(req, organizationId, siteId, action);
    if (!access.principal) return json(res, access.status, access.body, access.headers);
    // Session/operational events are site-scoped. Do not let a site-limited token
    // omit siteId and read events across every site in its organization.
    if (req.method === 'GET' && !siteId) {
      return json(res, 400, { error: 'site_id_required' });
    }

    if (!operationalEventStore.configured) {
      return json(res, 503, {
        error: 'event_store_not_configured',
        message: 'Set SPAIS_EVENTS_DB_PATH for durable SQLite persistence or SPAIS_EVENTS_FILE for the pilot JSONL store.'
      });
    }

    try {
      if (req.method === 'POST') {
        const event = createOperationalEvent({
          organizationId,
          actorId: access.principal.subjectId,
          input
        });
        await operationalEventStore.append(event);
        return json(res, 201, { event });
      }
      const requestedLimit = Number(url.searchParams.get('limit') || 100);
      const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(100, requestedLimit)) : 100;
      const events = await operationalEventStore.list({ organizationId, siteId, limit });
      return json(res, 200, { organizationId, events, count: events.length, limit });
    } catch (error) {
      if (error.code === 'event_store_limit_reached') {
        return json(res, 507, { error: 'event_store_limit_reached', message: 'Operational event store reached its configured pilot limit.' });
      }
      console.error('SPAIS operational event request failed:', error?.code || error?.name || 'unknown_error');
      return json(res, 500, { error: 'operational_event_request_failed' });
    }
  }

  // Operators create a short-lived challenge for a pending connector at an authorized site.
  const enrollmentChallengeRoute = url.pathname.match(/^\/api\/v1\/organizations\/([^/]+)\/connectors\/([^/]+)\/enrollment-challenges$/);
  if (enrollmentChallengeRoute) {
    if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
    let organizationId;
    let connectorId;
    try {
      organizationId = decodeURIComponent(enrollmentChallengeRoute[1]);
      connectorId = decodeURIComponent(enrollmentChallengeRoute[2]);
    } catch { return json(res, 400, { error: 'invalid_resource_id' }); }
    const siteId = url.searchParams.get('siteId') || undefined;
    if (!isResourceId(organizationId) || !isResourceId(connectorId)) return json(res, 400, { error: 'invalid_resource_id' });
    if (!isResourceId(siteId)) return json(res, 400, { error: 'site_id_required' });
    if (!spaisAuthConfigured || !resourceStore.configured) {
      return json(res, 503, { error: 'tenant_api_not_enabled' });
    }
    const authentication = await verifySpaisBearerTokenAsync(req.headers.authorization);
    if (!authentication.authenticated) {
      return json(res, 401, { error: 'unauthorized', reason: authentication.reason }, { 'www-authenticate': 'Bearer' });
    }
    const authorization = authorizeSpaisAction({
      principal: authentication.principal, organizationId, siteId, action: 'connector:manage'
    });
    if (!authorization.allowed) return json(res, 403, { error: 'forbidden', reason: authorization.reason });
    let input;
    try { input = await readJsonBody(req, 8 * 1024); }
    catch (error) {
      const status = error.code === 'request_body_too_large' ? 413 : 400;
      return json(res, status, { error: error.code || 'invalid_request_body' });
    }
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).length !== 1 || !Object.hasOwn(input, 'publicKeyJwk')) {
      return json(res, 400, { error: 'invalid_public_key' });
    }
    try {
      const challenge = await resourceStore.createConnectorEnrollmentChallenge({
        organizationId, siteId, connectorId, actorId: authentication.principal.subjectId,
        publicKeyJwk: input.publicKeyJwk
      });
      return json(res, 201, { enrollment: challenge });
    } catch (error) {
      if (error.code === 'connector_not_enrollable') return json(res, 409, { error: 'connector_not_enrollable' });
      if (error.code === 'invalid_public_key') return json(res, 400, { error: 'invalid_public_key' });
      console.error('SPAIS enrollment challenge failed:', error?.code || error?.name || 'unknown_error');
      return json(res, 500, { error: 'enrollment_challenge_failed' });
    }
  }

  // Connector completes enrollment with proof-of-possession of its own RSA private key.
  // The challenge is one-time, expires after ten minutes and is stored only as a hash.
  const enrollmentCompleteRoute = url.pathname.match(/^\/api\/v1\/connector-enrollments\/([^/]+)\/complete$/);
  if (enrollmentCompleteRoute) {
    if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' }, { allow: 'POST' });
    let enrollmentId;
    try { enrollmentId = decodeURIComponent(enrollmentCompleteRoute[1]); }
    catch { return json(res, 400, { error: 'invalid_enrollment_id' }); }
    if (!isResourceId(enrollmentId)) return json(res, 400, { error: 'invalid_enrollment_id' });
    if (!resourceStore.configured) return json(res, 503, { error: 'tenant_api_not_enabled' });
    let input;
    try { input = await readJsonBody(req, 8 * 1024); }
    catch (error) {
      const status = error.code === 'request_body_too_large' ? 413 : 400;
      return json(res, status, { error: error.code || 'invalid_request_body' });
    }
    const allowedFields = new Set(['challenge', 'signature']);
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => !allowedFields.has(key)) ||
        !input.challenge || !input.signature) {
      return json(res, 400, { error: 'invalid_enrollment_proof' });
    }
    try {
      const enrollment = await resourceStore.completeConnectorEnrollment({ enrollmentId, ...input });
      return json(res, 200, { enrollment });
    } catch (error) {
      if (error.code === 'enrollment_not_found') return json(res, 404, { error: 'enrollment_not_found' });
      if (error.code === 'enrollment_expired') return json(res, 410, { error: 'enrollment_expired' });
      if (error.code === 'enrollment_not_pending') return json(res, 409, { error: 'enrollment_not_pending' });
      if (error.code === 'connector_not_enrollable') return json(res, 409, { error: 'connector_not_enrollable' });
      if (error.code === 'invalid_enrollment_proof') return json(res, 401, { error: 'invalid_enrollment_proof' });
      if (error.code === 'invalid_public_key') return json(res, 400, { error: 'invalid_public_key' });
      console.error('SPAIS enrollment completion failed:', error?.code || error?.name || 'unknown_error');
      return json(res, 500, { error: 'enrollment_completion_failed' });
    }
  }

  // Report-based recording assessment is deliberately labelled unverified: signed connector metadata
  // can help find coverage gaps, but it is not independent proof that footage was recorded.
  const recordingAssuranceRoute = url.pathname.match(/^\/api\/v1\/organizations\/([^/]+)\/cameras\/([^/]+)\/recording-assurance$/);
  if (recordingAssuranceRoute) {
    if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' }, { allow: 'GET' });
    let organizationId;
    let cameraId;
    try {
      organizationId = decodeURIComponent(recordingAssuranceRoute[1]);
      cameraId = decodeURIComponent(recordingAssuranceRoute[2]);
    } catch { return json(res, 400, { error: 'invalid_resource_id' }); }
    const siteId = url.searchParams.get('siteId') || undefined;
    const windowStart = url.searchParams.get('windowStart') || undefined;
    const windowEnd = url.searchParams.get('windowEnd') || undefined;
    const maxReportAgeRaw = url.searchParams.get('maxReportAgeMinutes');
    const maxReportAgeMinutes = maxReportAgeRaw === null ? undefined : Number(maxReportAgeRaw);
    const query = { siteId, cameraId, windowStart, windowEnd, maxReportAgeMinutes };
    const validation = validateRecordingAssuranceQuery(query);
    if (!isResourceId(organizationId) || !validation.valid) {
      return json(res, 400, { error: 'invalid_recording_assurance_query', details: validation.errors });
    }
    if (!spaisAuthConfigured || !resourceStore.configured || !connectorTelemetryReceiver.configured) {
      return json(res, 503, { error: 'recording_assurance_not_enabled', message: 'Configure trusted bearer identity and persistent SPAIS SQLite storage first.' });
    }
    const authentication = await verifySpaisBearerTokenAsync(req.headers.authorization);
    if (!authentication.authenticated) {
      return json(res, 401, { error: 'unauthorized', reason: authentication.reason }, { 'www-authenticate': 'Bearer' });
    }
    const authorization = authorizeSpaisAction({
      principal: authentication.principal, organizationId, siteId, action: 'camera:read'
    });
    if (!authorization.allowed) return json(res, 403, { error: 'forbidden', reason: authorization.reason });
    try {
      const camera = await resourceStore.get({ organizationId, resourceType: 'camera', resourceId: cameraId, siteId });
      if (!camera) return json(res, 404, { error: 'camera_not_found' });
      const normalizedStart = new Date(Date.parse(windowStart)).toISOString();
      const normalizedEnd = new Date(Date.parse(windowEnd)).toISOString();
      const coverage = await connectorTelemetryReceiver.listCoverageReports({
        organizationId, siteId, cameraId, windowStart: normalizedStart, windowEnd: normalizedEnd
      });
      const assessment = evaluateRecordingCoverageReports({
        organizationId, siteId, cameraId, reports: coverage.reports, reportsTruncated: coverage.truncated,
        windowStart: normalizedStart, windowEnd: normalizedEnd,
        maxReportAgeMinutes: maxReportAgeMinutes ?? 10
      });
      return json(res, 200, { assessment });
    } catch (error) {
      if (error.code === 'invalid_recording_assurance_query') {
        return json(res, 400, { error: error.code });
      }
      console.error('SPAIS recording assurance assessment failed:', error?.code || error?.name || 'unknown_error');
      return json(res, 500, { error: 'recording_assurance_assessment_failed' });
    }
  }

  // Site, camera and connector metadata use the persistent SQLite registry.
  // Camera/connector operations are site-scoped; their status cannot be set to active by inventory CRUD.
  const resourceRoute = url.pathname.match(/^\/api\/v1\/organizations\/([^/]+)\/(sites|cameras|connectors)(?:\/([^/]+))?$/);
  if (resourceRoute) {
    const resourceIdSegment = resourceRoute[3];
    const allowedMethods = resourceIdSegment ? ['GET', 'PATCH'] : ['GET', 'POST'];
    if (!allowedMethods.includes(req.method)) {
      return json(res, 405, { error: 'method_not_allowed' }, { allow: allowedMethods.join(', ') });
    }
    let organizationId;
    let resourceId;
    try {
      organizationId = decodeURIComponent(resourceRoute[1]);
      resourceId = resourceIdSegment ? decodeURIComponent(resourceIdSegment) : undefined;
    } catch { return json(res, 400, { error: 'invalid_resource_id' }); }
    if (!isResourceId(organizationId)) return json(res, 400, { error: 'invalid_organization_id' });
    if (resourceId && !isResourceId(resourceId)) return json(res, 400, { error: 'invalid_resource_id' });
    if (!spaisAuthConfigured || !resourceStore.configured) {
      return json(res, 503, {
        error: 'tenant_api_not_enabled',
        message: 'Configure trusted bearer-token verification and SPAIS_EVENTS_DB_PATH before using tenant resource APIs.'
      });
    }

    const resourceType = resourceRoute[2] === 'sites' ? 'site' : resourceRoute[2] === 'cameras' ? 'camera' : 'connector';
    let input;
    let siteId = url.searchParams.get('siteId') || undefined;
    if (req.method === 'POST' || req.method === 'PATCH') {
      try { input = await readJsonBody(req); }
      catch (error) {
        const status = error.code === 'request_body_too_large' ? 413 : 400;
        return json(res, status, { error: error.code || 'invalid_request_body' });
      }
      const validation = req.method === 'POST'
        ? validateSpaisResourceInput(resourceType, input)
        : validateSpaisResourcePatch(resourceType, input);
      if (!validation.valid) return json(res, 400, { error: 'invalid_resource', details: validation.errors });
      if (req.method === 'POST' && resourceType !== 'site') siteId = input.siteId;
    }
    if (siteId && !isResourceId(siteId)) return json(res, 400, { error: 'invalid_site_id' });
    if (resourceType !== 'site' && !siteId) {
      return json(res, 400, { error: 'site_id_required', message: 'Camera and connector operations must specify an authorized siteId.' });
    }
    if (resourceType === 'site' && siteId) {
      return json(res, 400, { error: 'site_id_not_applicable', message: 'Site resources are scoped at organization level.' });
    }

    const action = resourceType + ':' + (req.method === 'GET' ? 'read' : 'manage');
    const authentication = await verifySpaisBearerTokenAsync(req.headers.authorization);
    if (!authentication.authenticated) {
      return json(res, 401, { error: 'unauthorized', reason: authentication.reason }, { 'www-authenticate': 'Bearer' });
    }
    // A single-site inventory operation must authorize the site named in the path.
    // Collection reads are filtered to the principal's explicit site scope below.
    const authorizationSiteId = resourceType === 'site' && resourceId ? resourceId : siteId;
    const authorization = authorizeSpaisAction({
      principal: authentication.principal,
      organizationId,
      ...(authorizationSiteId ? { siteId: authorizationSiteId } : {}),
      action
    });
    if (!authorization.allowed) {
      return json(res, 403, { error: 'forbidden', reason: authorization.reason });
    }

    try {
      if (req.method === 'POST') {
        const resource = await resourceStore.create({
          organizationId,
          actorId: authentication.principal.subjectId,
          resourceType,
          input
        });
        return json(res, 201, { resource });
      }
      if (req.method === 'PATCH') {
        const resource = await resourceStore.update({
          organizationId,
          actorId: authentication.principal.subjectId,
          resourceType,
          resourceId,
          siteId,
          patch: input
        });
        return json(res, 200, { resource });
      }
      if (resourceId) {
        const resource = await resourceStore.get({ organizationId, resourceType, resourceId, siteId });
        return resource
          ? json(res, 200, { resource })
          : json(res, 404, { error: 'resource_not_found' });
      }
      const requestedLimit = Number(url.searchParams.get('limit') || 100);
      const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(100, requestedLimit)) : 100;
      const scopedSites = authentication.principal.sitesByOrganization;
      const resourceIds = resourceType === 'site' && scopedSites && Object.hasOwn(scopedSites, organizationId)
        ? scopedSites[organizationId]
        : undefined;
      const resources = await resourceStore.list({ organizationId, resourceType, siteId, resourceIds, limit });
      return json(res, 200, { organizationId, resourceType, resources, count: resources.length, limit });
    } catch (error) {
      if (error.code === 'invalid_resource' || error.code === 'invalid_resource_patch') {
        return json(res, 400, { error: 'invalid_resource', details: error.validationErrors || [] });
      }
      if (error.code === 'resource_already_exists') return json(res, 409, { error: 'resource_already_exists' });
      if (error.code === 'site_not_found') return json(res, 404, { error: 'site_not_found' });
      if (error.code === 'resource_not_found') return json(res, 404, { error: 'resource_not_found' });
      console.error('SPAIS resource request failed:', error?.code || error?.name || 'unknown_error');
      return json(res, 500, { error: 'resource_request_failed' });
    }
  }


  // Incident lifecycle: every operation is tenant/site scoped and auditable.
  const incidentRoute = url.pathname.match(/^\/api\/v1\/organizations\/([^/]+)\/incidents(?:\/([^/]+))?$/);
  if (incidentRoute) {
    const incidentIdSegment = incidentRoute[2];
    const allowedMethods = incidentIdSegment ? ['GET', 'PATCH'] : ['GET', 'POST'];
    if (!allowedMethods.includes(req.method)) return json(res, 405, { error: 'method_not_allowed' }, { allow: allowedMethods.join(', ') });
    let organizationId;
    let incidentId;
    try {
      organizationId = decodeURIComponent(incidentRoute[1]);
      incidentId = incidentIdSegment ? decodeURIComponent(incidentIdSegment) : undefined;
    } catch { return json(res, 400, { error: 'invalid_resource_id' }); }
    if (!isResourceId(organizationId) || (incidentId && !isResourceId(incidentId))) return json(res, 400, { error: 'invalid_resource_id' });
    if (!spaisAuthConfigured || !resourceStore.configured || !incidentStore.configured) {
      return json(res, 503, { error: 'incident_api_not_enabled', message: 'Configure trusted bearer-token verification and SPAIS_EVENTS_DB_PATH before using incident APIs.' });
    }
    let input;
    let siteId = url.searchParams.get('siteId') || undefined;
    if (req.method === 'POST' || req.method === 'PATCH') {
      try { input = await readJsonBody(req, 16 * 1024); }
      catch (error) {
        const status = error.code === 'request_body_too_large' ? 413 : 400;
        return json(res, status, { error: error.code || 'invalid_request_body' });
      }
      const validation = req.method === 'POST' ? validateIncidentInput(input) : validateIncidentTransition(input);
      if (!validation.valid) return json(res, 400, { error: req.method === 'POST' ? 'invalid_incident' : 'invalid_incident_transition', details: validation.errors });
      if (req.method === 'POST') siteId = input.siteId;
    }
    if (!isResourceId(siteId)) return json(res, 400, { error: 'site_id_required' });
    const action = req.method === 'GET' ? 'incident:read' : 'incident:manage';
    const authentication = await verifySpaisBearerTokenAsync(req.headers.authorization);
    if (!authentication.authenticated) return json(res, 401, { error: 'unauthorized', reason: authentication.reason }, { 'www-authenticate': 'Bearer' });
    const authorization = authorizeSpaisAction({ principal: authentication.principal, organizationId, siteId, action });
    if (!authorization.allowed) return json(res, 403, { error: 'forbidden', reason: authorization.reason });
    try {
      const site = await resourceStore.get({ organizationId, resourceType: 'site', resourceId: siteId });
      if (!site || site.status !== 'active') return json(res, 404, { error: 'site_not_found' });
      if (req.method === 'POST') {
        // Link only an approved, immutable SOP version from the same tenant and site.
        // The client cannot link a draft, another site's version, or another tenant's record.
        if (input.sopVersionId) {
          const linkedSop = await sopStore.get({ organizationId, siteId, sopId: input.sopVersionId });
          if (!linkedSop || linkedSop.status !== 'approved') {
            return json(res, 409, { error: 'linked_sop_not_approved_or_not_found' });
          }
        }
        const idempotencyKey = req.headers['idempotency-key'];
        if (idempotencyKey !== undefined &&
            (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey))) {
          return json(res, 400, { error: 'invalid_idempotency_key' });
        }
        const result = await incidentStore.create({
          organizationId, actorId: authentication.principal.subjectId, input, idempotencyKey
        });
        if (result.replayed) return json(res, 200, { incident: result.incident, idempotentReplay: true });
        return json(res, 201, { incident: result.incident });
      }
      if (req.method === 'PATCH') {
        const incident = await incidentStore.transition({
          organizationId, siteId, incidentId, actorId: authentication.principal.subjectId,
          status: input.status, note: input.note
        });
        return json(res, 200, { incident });
      }
      if (incidentId) {
        const incident = await incidentStore.get({ organizationId, siteId, incidentId });
        return incident ? json(res, 200, { incident }) : json(res, 404, { error: 'incident_not_found' });
      }
      const requestedLimit = Number(url.searchParams.get('limit') || 100);
      const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(100, requestedLimit)) : 100;
      const incidents = await incidentStore.list({ organizationId, siteId, limit });
      return json(res, 200, { organizationId, siteId, incidents, count: incidents.length, limit });
    } catch (error) {
      if (error.code === 'incident_not_found') return json(res, 404, { error: 'incident_not_found' });
      if (error.code === 'invalid_idempotency_key') return json(res, 400, { error: error.code });
      if (error.code === 'idempotency_key_reused_with_different_payload') return json(res, 409, { error: error.code });
      if (error.code === 'idempotency_record_corrupt') return json(res, 500, { error: error.code });
      if (error.code === 'invalid_incident_transition') return json(res, 409, { error: error.code, details: error.validationErrors || [] });
      console.error('SPAIS incident request failed:', error?.code || error?.name || 'unknown_error');
      return json(res, 500, { error: 'incident_request_failed' });
    }
  }

  // SOP/policy versions are site-scoped, immutable after approval, and independently approved.
  const sopRoute = url.pathname.match(/^\/api\/v1\/organizations\/([^/]+)\/sops(?:\/([^/]+))?$/);
  if (sopRoute) {
    const sopIdSegment = sopRoute[2];
    const allowedMethods = sopIdSegment ? ['GET', 'PATCH'] : ['GET', 'POST'];
    if (!allowedMethods.includes(req.method)) return json(res, 405, { error: 'method_not_allowed' }, { allow: allowedMethods.join(', ') });
    let organizationId;
    let sopId;
    try {
      organizationId = decodeURIComponent(sopRoute[1]);
      sopId = sopIdSegment ? decodeURIComponent(sopIdSegment) : undefined;
    } catch { return json(res, 400, { error: 'invalid_resource_id' }); }
    if (!isResourceId(organizationId) || (sopId && !isResourceId(sopId))) return json(res, 400, { error: 'invalid_resource_id' });
    if (!spaisAuthConfigured || !resourceStore.configured || !sopStore.configured) {
      return json(res, 503, { error: 'sop_api_not_enabled', message: 'Configure trusted bearer-token verification and SPAIS_EVENTS_DB_PATH before using SOP APIs.' });
    }
    let input;
    let siteId = url.searchParams.get('siteId') || undefined;
    if (req.method === 'POST' || req.method === 'PATCH') {
      try { input = await readJsonBody(req, 20 * 1024); }
      catch (error) {
        const status = error.code === 'request_body_too_large' ? 413 : 400;
        return json(res, status, { error: error.code || 'invalid_request_body' });
      }
      const validation = req.method === 'POST' ? validateSopInput(input) : validateSopTransition(input);
      if (!validation.valid) return json(res, 400, { error: req.method === 'POST' ? 'invalid_sop' : 'invalid_sop_transition', details: validation.errors });
      if (req.method === 'POST') siteId = input.siteId;
    }
    if (!isResourceId(siteId)) return json(res, 400, { error: 'site_id_required' });
    const action = req.method === 'GET' ? 'sop:read'
      : req.method === 'PATCH' && input.status === 'approved' ? 'sop:approve' : 'sop:manage';
    const authentication = await verifySpaisBearerTokenAsync(req.headers.authorization);
    if (!authentication.authenticated) return json(res, 401, { error: 'unauthorized', reason: authentication.reason }, { 'www-authenticate': 'Bearer' });
    const authorization = authorizeSpaisAction({ principal: authentication.principal, organizationId, siteId, action });
    if (!authorization.allowed) return json(res, 403, { error: 'forbidden', reason: authorization.reason });
    try {
      const site = await resourceStore.get({ organizationId, resourceType: 'site', resourceId: siteId });
      if (!site || site.status !== 'active') return json(res, 404, { error: 'site_not_found' });
      if (req.method === 'POST') {
        const sop = await sopStore.create({ organizationId, actorId: authentication.principal.subjectId, input });
        return json(res, 201, { sop });
      }
      if (req.method === 'PATCH') {
        const sop = await sopStore.transition({
          organizationId, siteId, sopId, actorId: authentication.principal.subjectId,
          status: input.status, note: input.note
        });
        return json(res, 200, { sop });
      }
      if (sopId) {
        const sop = await sopStore.get({ organizationId, siteId, sopId });
        return sop ? json(res, 200, { sop }) : json(res, 404, { error: 'sop_not_found' });
      }
      const requestedLimit = Number(url.searchParams.get('limit') || 100);
      const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(100, requestedLimit)) : 100;
      const sops = await sopStore.list({ organizationId, siteId, limit });
      return json(res, 200, { organizationId, siteId, sops, count: sops.length, limit });
    } catch (error) {
      if (error.code === 'sop_not_found') return json(res, 404, { error: 'sop_not_found' });
      if (error.code === 'sop_self_approval_denied') return json(res, 409, { error: error.code });
      if (error.code === 'invalid_sop_transition') return json(res, 409, { error: error.code, details: error.validationErrors || [] });
      console.error('SPAIS SOP request failed:', error?.code || error?.name || 'unknown_error');
      return json(res, 500, { error: 'sop_request_failed' });
    }
  }

  // Signed evaluator reports are accepted only from the server-configured evaluator key.
  const learningEvaluationRoute = url.pathname.match(/^\/api\/v1\/organizations\/([^/]+)\/model-candidates\/([^/]+)\/evaluations$/);
  if (learningEvaluationRoute) {
    if (!['GET', 'POST'].includes(req.method)) return json(res, 405, { error: 'method_not_allowed' }, { allow: 'GET, POST' });
    let organizationId;
    let candidateId;
    try {
      organizationId = decodeURIComponent(learningEvaluationRoute[1]);
      candidateId = decodeURIComponent(learningEvaluationRoute[2]);
    } catch { return json(res, 400, { error: 'invalid_resource_id' }); }
    if (!isResourceId(organizationId) || !isResourceId(candidateId)) return json(res, 400, { error: 'invalid_resource_id' });
    const siteId = url.searchParams.get('siteId') || undefined;
    if (!isResourceId(siteId)) return json(res, 400, { error: 'site_id_required' });
    if (!spaisAuthConfigured || !resourceStore.configured || !learningCandidateStore.configured) {
      return json(res, 503, { error: 'learning_evaluation_api_not_enabled' });
    }
    const authentication = await verifySpaisBearerTokenAsync(req.headers.authorization);
    if (!authentication.authenticated) return json(res, 401, { error: 'unauthorized', reason: authentication.reason }, { 'www-authenticate': 'Bearer' });
    const action = req.method === 'GET' ? 'model:read' : 'model:evaluate';
    const authorization = authorizeSpaisAction({ principal: authentication.principal, organizationId, siteId, action });
    if (!authorization.allowed) return json(res, 403, { error: 'forbidden', reason: authorization.reason });
    try {
      const site = await resourceStore.get({ organizationId, resourceType: 'site', resourceId: siteId });
      if (!site || site.status !== 'active') return json(res, 404, { error: 'site_not_found' });
      const candidate = await learningCandidateStore.get({ organizationId, siteId, candidateId });
      if (!candidate) return json(res, 404, { error: 'learning_candidate_not_found' });
      if (req.method === 'GET') {
        const requestedLimit = Number(url.searchParams.get('limit') || 100);
        const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(100, requestedLimit)) : 100;
        const evaluations = await learningCandidateStore.listEvaluations({ organizationId, siteId, candidateId, limit });
        return json(res, 200, { organizationId, siteId, candidateId, evaluations, count: evaluations.length, limit });
      }
      let report;
      try { report = await readJsonBody(req, 16 * 1024); }
      catch (error) {
        const status = error.code === 'request_body_too_large' ? 413 : 400;
        return json(res, status, { error: error.code || 'invalid_request_body' });
      }
      const validation = validateLearningEvaluationReport(report);
      if (!validation.valid) return json(res, 400, { error: 'invalid_evaluation_report', details: validation.errors });
      const evaluatorConfig = getTrustedLearningEvaluatorConfig();
      if (!evaluatorConfig) {
        return json(res, 503, { error: 'trusted_evaluator_not_configured', message: 'Configure the evaluator RSA public JWK and explicit acceptance thresholds before accepting reports.' });
      }
      const verification = verifyLearningEvaluationAttestation({ organizationId, siteId, candidateId, report, evaluatorConfig });
      if (!verification.valid) {
        const status = verification.reason === 'trusted_evaluator_not_configured' ? 503 : 401;
        return json(res, status, { error: verification.reason });
      }
      const evaluation = await learningCandidateStore.recordEvaluation({
        organizationId, siteId, candidateId, actorId: authentication.principal.subjectId, report, verification
      });
      return json(res, 201, { evaluation });
    } catch (error) {
      if (error.code === 'learning_candidate_not_found') return json(res, 404, { error: error.code });
      if (error.code === 'learning_candidate_not_evaluation_pending' || error.code === 'learning_evaluation_digest_mismatch') {
        return json(res, 409, { error: error.code });
      }
      if (error.code === 'learning_evaluation_replay_detected') return json(res, 409, { error: error.code });
      if (error.code === 'invalid_learning_evaluation_query') return json(res, 400, { error: error.code });
      console.error('SPAIS learning evaluation request failed:', error?.code || error?.name || 'unknown_error');
      return json(res, 500, { error: 'learning_evaluation_request_failed' });
    }
  }

  // Learning sources are tenant/site scoped; uploaded media is stored on the customer-controlled host.
  const learningSourcesRoute = url.pathname.match(/^\/api\/v1\/organizations\/([^/]+)\/learning-sources(?:\/([^/]+))?$/);
  if (learningSourcesRoute) {
    const sourceIdSegment = learningSourcesRoute[2];
    const allowedMethods = sourceIdSegment ? ['DELETE'] : ['GET', 'POST'];
    if (!allowedMethods.includes(req.method)) return json(res, 405, { error: 'method_not_allowed' }, { allow: allowedMethods.join(', ') });
    let organizationId;
    let sourceId;
    try {
      organizationId = decodeURIComponent(learningSourcesRoute[1]);
      sourceId = sourceIdSegment ? decodeURIComponent(sourceIdSegment) : undefined;
    } catch { return json(res, 400, { error: 'invalid_resource_id' }); }
    if (!isResourceId(organizationId) || (sourceId && !isResourceId(sourceId))) return json(res, 400, { error: 'invalid_resource_id' });
    const siteId = url.searchParams.get('siteId') || undefined;
    if (!isResourceId(siteId)) return json(res, 400, { error: 'site_id_required' });
    if (!spaisAuthConfigured || !resourceStore.configured || !learningSourceStore.configured) {
      return json(res, 503, { error: 'learning_sources_not_enabled' });
    }
    const authentication = await verifySpaisBearerTokenAsync(req.headers.authorization);
    if (!authentication.authenticated) return json(res, 401, { error: 'unauthorized', reason: authentication.reason }, { 'www-authenticate': 'Bearer' });
    const action = req.method === 'GET' ? 'model:read'
      : req.method === 'DELETE' ? 'model:manage' : 'model:propose';
    const authorization = authorizeSpaisAction({ principal: authentication.principal, organizationId, siteId, action });
    if (!authorization.allowed) return json(res, 403, { error: 'forbidden', reason: authorization.reason });
    try {
      const site = await resourceStore.get({ organizationId, resourceType: 'site', resourceId: siteId });
      if (!site || site.status !== 'active') return json(res, 404, { error: 'site_not_found' });
      if (req.method === 'DELETE') {
        const result = await learningSourceStore.delete({
          organizationId, siteId, sourceId, actorId: authentication.principal.subjectId
        });
        if (!result.deleted) return json(res, 404, { error: 'learning_source_not_found' });
        return json(res, 200, { sourceId, deleted: true, mediaCleanupPending: result.mediaCleanupPending });
      }
      if (req.method === 'GET') {
        const requestedLimit = Number(url.searchParams.get('limit') || 100);
        const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(100, requestedLimit)) : 100;
        const sources = await learningSourceStore.list({ organizationId, siteId, limit });
        return json(res, 200, { organizationId, siteId, sources, count: sources.length, limit });
      }
      let input;
      try { input = await readJsonBody(req, 12 * 1024 * 1024); }
      catch (error) {
        const status = error.code === 'request_body_too_large' ? 413 : 400;
        return json(res, status, { error: error.code || 'invalid_request_body' });
      }
      if (input?.siteId !== siteId) return json(res, 400, { error: 'site_scope_mismatch' });
      const source = await learningSourceStore.create({ organizationId, principal: authentication.principal, input });
      return json(res, 201, { source });
    } catch (error) {
      if (error.code === 'invalid_learning_source') return json(res, 400, { error: error.code, details: error.validationErrors || [] });
      if (error.code === 'document_text_too_large') return json(res, 413, { error: error.code });
      if (error.code === 'invalid_learning_source_delete') return json(res, 400, { error: error.code });
      if (error.code === 'learning_source_media_cleanup_failed') return json(res, 503, { error: error.code, retryable: true });
      if (['invalid_or_oversized_file_payload','file_signature_mismatch'].includes(error.code)) return json(res, 400, { error: error.code });
      console.error('CountAI learning source request failed:', error?.code || error?.name || 'unknown_error');
      return json(res, 500, { error: 'learning_source_request_failed' });
    }
  }

  // Learning candidates are metadata-only proposals. No API in this lifecycle promotes a model to production.
  const learningCandidateRoute = url.pathname.match(/^\/api\/v1\/organizations\/([^/]+)\/model-candidates(?:\/([^/]+))?$/);
  if (learningCandidateRoute) {
    const candidateIdSegment = learningCandidateRoute[2];
    const allowedMethods = candidateIdSegment ? ['GET', 'PATCH'] : ['GET', 'POST'];
    if (!allowedMethods.includes(req.method)) return json(res, 405, { error: 'method_not_allowed' }, { allow: allowedMethods.join(', ') });
    let organizationId;
    let candidateId;
    try {
      organizationId = decodeURIComponent(learningCandidateRoute[1]);
      candidateId = candidateIdSegment ? decodeURIComponent(candidateIdSegment) : undefined;
    } catch { return json(res, 400, { error: 'invalid_resource_id' }); }
    if (!isResourceId(organizationId) || (candidateId && !isResourceId(candidateId))) return json(res, 400, { error: 'invalid_resource_id' });
    let input;
    let siteId = url.searchParams.get('siteId') || undefined;
    if (req.method === 'POST' || req.method === 'PATCH') {
      try { input = await readJsonBody(req, 24 * 1024); }
      catch (error) {
        const status = error.code === 'request_body_too_large' ? 413 : 400;
        return json(res, status, { error: error.code || 'invalid_request_body' });
      }
      const validation = req.method === 'POST'
        ? validateLearningCandidateInput(input)
        : validateLearningCandidateTransition(input);
      if (!validation.valid) {
        return json(res, 400, {
          error: req.method === 'POST' ? 'invalid_learning_candidate' : 'invalid_learning_candidate_transition',
          details: validation.errors
        });
      }
      if (req.method === 'POST') siteId = input.siteId;
    }
    if (!isResourceId(siteId)) return json(res, 400, { error: 'site_id_required' });
    if (!spaisAuthConfigured || !resourceStore.configured || !learningCandidateStore.configured) {
      return json(res, 503, { error: 'learning_candidate_api_not_enabled', message: 'Configure trusted bearer identity and persistent SPAIS SQLite storage first.' });
    }
    const authentication = await verifySpaisBearerTokenAsync(req.headers.authorization);
    if (!authentication.authenticated) return json(res, 401, { error: 'unauthorized', reason: authentication.reason }, { 'www-authenticate': 'Bearer' });
    const action = req.method === 'GET' ? 'model:read' : req.method === 'POST' ? 'model:propose' : 'model:approve';
    const authorization = authorizeSpaisAction({ principal: authentication.principal, organizationId, siteId, action });
    if (!authorization.allowed) return json(res, 403, { error: 'forbidden', reason: authorization.reason });
    try {
      const site = await resourceStore.get({ organizationId, resourceType: 'site', resourceId: siteId });
      if (!site || site.status !== 'active') return json(res, 404, { error: 'site_not_found' });
      if (req.method === 'POST') {
        const candidate = await learningCandidateStore.create({
          organizationId, actorId: authentication.principal.subjectId, input
        });
        return json(res, 201, { candidate });
      }
      if (req.method === 'PATCH') {
        const candidate = await learningCandidateStore.transition({
          organizationId, siteId, candidateId, actorId: authentication.principal.subjectId,
          status: input.status, note: input.note
        });
        return json(res, 200, { candidate });
      }
      if (candidateId) {
        const candidate = await learningCandidateStore.get({ organizationId, siteId, candidateId });
        return candidate ? json(res, 200, { candidate }) : json(res, 404, { error: 'learning_candidate_not_found' });
      }
      const requestedLimit = Number(url.searchParams.get('limit') || 100);
      const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(100, requestedLimit)) : 100;
      const candidates = await learningCandidateStore.list({ organizationId, siteId, limit });
      return json(res, 200, { organizationId, siteId, candidates, count: candidates.length, limit });
    } catch (error) {
      if (error.code === 'learning_candidate_not_found') return json(res, 404, { error: 'learning_candidate_not_found' });
      if (error.code === 'learning_candidate_self_approval_denied') return json(res, 409, { error: error.code });
      if (error.code === 'invalid_learning_candidate_transition') return json(res, 409, { error: error.code, details: error.validationErrors || [] });
      if (error.code === 'invalid_learning_candidate' || error.code === 'invalid_learning_candidate_query') {
        return json(res, 400, { error: error.code, details: error.validationErrors || [] });
      }
      console.error('SPAIS learning candidate request failed:', error?.code || error?.name || 'unknown_error');
      return json(res, 500, { error: 'learning_candidate_request_failed' });
    }
  }

  const auditRoute = url.pathname.match(/^\/api\/v1\/organizations\/([^/]+)\/audit$/);
  if (auditRoute) {
    if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' }, { allow: 'GET' });
    let organizationId;
    try { organizationId = decodeURIComponent(auditRoute[1]); }
    catch { return json(res, 400, { error: 'invalid_organization_id' }); }
    if (!isResourceId(organizationId)) return json(res, 400, { error: 'invalid_organization_id' });
    if (!spaisAuthConfigured || !resourceStore.configured) {
      return json(res, 503, {
        error: 'tenant_api_not_enabled',
        message: 'Configure trusted bearer-token verification and SPAIS_EVENTS_DB_PATH before using tenant audit APIs.'
      });
    }
    const siteId = url.searchParams.get('siteId') || undefined;
    if (siteId && !isResourceId(siteId)) return json(res, 400, { error: 'invalid_site_id' });
    const authentication = await verifySpaisBearerTokenAsync(req.headers.authorization);
    if (!authentication.authenticated) {
      return json(res, 401, { error: 'unauthorized', reason: authentication.reason }, { 'www-authenticate': 'Bearer' });
    }
    // Audit entries can contain site-level operational details. Require an explicit
    // site filter because the current token contract has no separate org-wide audit scope.
    if (!siteId) return json(res, 400, { error: 'site_id_required' });
    const authorization = authorizeSpaisAction({
      principal: authentication.principal,
      organizationId,
      siteId,
      action: 'audit:read'
    });
    if (!authorization.allowed) return json(res, 403, { error: 'forbidden', reason: authorization.reason });
    try {
      const requestedLimit = Number(url.searchParams.get('limit') || 100);
      const limit = Number.isInteger(requestedLimit) ? Math.max(1, Math.min(100, requestedLimit)) : 100;
      const events = await resourceStore.listAudit({ organizationId, siteId, limit });
      return json(res, 200, { organizationId, events, count: events.length, limit });
    } catch (error) {
      console.error('SPAIS audit request failed:', error?.code || error?.name || 'unknown_error');
      return json(res, 500, { error: 'audit_request_failed' });
    }
  }

  // Tenant resource APIs other than operational events fail closed until their
  // trusted identity, authorization and persistence paths are implemented.
  if (url.pathname.startsWith('/api/v1/organizations') || url.pathname.startsWith('/api/v1/sites') ||
      url.pathname.startsWith('/api/v1/cameras') || url.pathname.startsWith('/api/v1/connectors') ||
      url.pathname.startsWith('/api/v1/incidents') || url.pathname.startsWith('/api/v1/sops') ||
      url.pathname.startsWith('/api/v1/models') || url.pathname.startsWith('/api/v1/audit')) {
    return json(res, 503, {
      error: 'tenant_api_not_enabled',
      message: 'Tenant-scoped SPAIS APIs are disabled until trusted authentication, authorization and persistence are configured.'
    });
  }
  if (url.pathname === '/api/recognize' && req.method === 'POST') {
    return json(res, 501, {error:'Cloud recognition provider is not configured. No image was analyzed by a cloud service.'});
  }
  if (url.pathname.startsWith('/api/')) return json(res, 404, {error:'Not found'});
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); }
  catch { res.writeHead(400); return res.end('Bad request'); }
  let file = normalize(join(root, pathname));
  if (!file.startsWith(root)) { res.writeHead(400); return res.end('Bad request'); }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) file = join(root, 'index.html');
  if (!existsSync(file)) { res.writeHead(503, {'content-type':'text/plain'}); return res.end('SPAIS has not been built. Run npm run build first.'); }
  res.writeHead(200, {
    'content-type': mime[extname(file)] || 'application/octet-stream',
    'cache-control': staticCacheControl(file),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin'
  });
  createReadStream(file).pipe(res);
});
// Bound connection/header handling to reduce slow-client resource exhaustion.
server.headersTimeout = positiveIntegerSetting('COUNTAI_HEADERS_TIMEOUT_MS', 15_000);
server.requestTimeout = positiveIntegerSetting('COUNTAI_REQUEST_TIMEOUT_MS', 120_000);
server.keepAliveTimeout = positiveIntegerSetting('COUNTAI_KEEPALIVE_TIMEOUT_MS', 5_000);
server.maxHeadersCount = 100;
server.listen(port, '0.0.0.0', () => console.log(`CountAI API listening on ${port}`));
