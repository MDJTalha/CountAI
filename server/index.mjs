import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { extname, join, normalize } from 'node:path';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { getSpaisContractManifest, authorizeSpaisAction, isResourceId } from './spais/contracts.mjs';
import { verifySpaisBearerTokenAsync } from './spais/authOidc.mjs';
import { createSqliteSpaisResourceStore, validateSpaisResourceInput, validateSpaisResourcePatch } from './spais/resources.mjs';
import { createConnectorTelemetryReceiver } from './spais/connectorTelemetry.mjs';
import {
  createOperationalEvent,
  createOperationalEventStore,
  createSqliteOperationalEventStore,
  validateOperationalEvent
} from './spais/operationalEvents.mjs';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const port = Number(process.env.PORT || 8787);
const operationalEventStore = process.env.SPAIS_EVENTS_DB_PATH
  ? createSqliteOperationalEventStore(process.env.SPAIS_EVENTS_DB_PATH)
  : createOperationalEventStore();
const resourceStore = createSqliteSpaisResourceStore(process.env.SPAIS_EVENTS_DB_PATH);
const connectorTelemetryReceiver = createConnectorTelemetryReceiver({
  databasePath: process.env.SPAIS_EVENTS_DB_PATH,
  resourceStore
});
const spaisAuthConfigured = Boolean(
  (process.env.SPAIS_AUTH_JWKS_URL || process.env.SPAIS_AUTH_HS256_SECRET) &&
  process.env.SPAIS_AUTH_ISSUER && process.env.SPAIS_AUTH_AUDIENCE
);
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.webmanifest':'application/manifest+json', '.png':'image/png', '.ico':'image/x-icon' };
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
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/api/health') return json(res, 200, {ok:true, service:'countai-api', cloudRecognitionConfigured:false});
  if (url.pathname === '/api/v1/spais/contracts' && req.method === 'GET') {
    return json(res, 200, getSpaisContractManifest({
      authenticationConfigured: spaisAuthConfigured,
      tenantResourceApiEnabled: spaisAuthConfigured && resourceStore.configured
    }));
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
      'organizationId', 'siteId', 'connectorId', 'timestamp', 'nonce', 'eventType', 'payload', 'signature'
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
      if (error.code === 'invalid_telemetry_signature') return json(res, 401, { error: error.code });
      if (error.code === 'telemetry_replay_detected') return json(res, 409, { error: error.code });
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
    const authorization = authorizeSpaisAction({
      principal: authentication.principal,
      organizationId,
      ...(siteId ? { siteId } : {}),
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
      const resources = await resourceStore.list({ organizationId, resourceType, siteId, limit });
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
    const authorization = authorizeSpaisAction({
      principal: authentication.principal,
      organizationId,
      ...(siteId ? { siteId } : {}),
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
  res.writeHead(200, {'content-type':mime[extname(file)] || 'application/octet-stream','x-content-type-options':'nosniff','referrer-policy':'strict-origin-when-cross-origin'});
  createReadStream(file).pipe(res);
});
server.listen(port, '0.0.0.0', () => console.log(`SPAIS API listening on ${port}`));
