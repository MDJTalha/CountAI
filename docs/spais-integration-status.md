# SPAIS integration status — CountAI codebase

## Product direction
CountAI is being evolved into SPAIS in the existing React/TypeScript/Vite PWA. Preserve existing counting and local review while adding enterprise surveillance and operational workflows incrementally.

## Implemented on `main`
- SPAIS product identity and operations-oriented dashboard foundation.
- Versioned API contract manifest at `GET /api/v1/spais/contracts`.
- Server-side resource-envelope validation and deny-by-default organization/site/action authorization helpers.
- Configurable HS256 bearer-token verification requiring a server-side secret, issuer and audience; checks signature, expiry, issuer, audience and tenant claims. It does not issue tokens or replace an identity provider.
- Authenticated, organization/site-scoped operational event API with server-assigned actor identity and bounded request validation.
- Persistent SQLite event storage for single-host deployments plus JSONL pilot fallback; SQLite uses transactions, unique event IDs, WAL and indexed organization/site reads.
- Bounded browser-local live-session history and operational event trail, including explicit count-reset events.
- Regression coverage for contract versioning, authentication, event validation, tenant/site isolation, persistence, and live-session storage.

## Implemented on `main`
- Tenant-scoped site, camera and connector metadata endpoints using verified bearer-token scope and the persistent SQLite registry.
- Server-side organization/site/action checks, with camera and connector reads requiring an authorized site filter.
- Resource validation, duplicate-ID rejection, registered-site checks for child resources, server-assigned creator identity and rejection of credential/stream-URL metadata.
- API readiness manifest reflects whether authentication settings and SQLite persistence are configured.

## Implemented on `main`
- Adds an optional OIDC/JWKS RS256 token-verification path alongside the existing HS256 service-token adapter.
- Uses only a server-configured JWKS URL; rejects token-supplied `jku`/`x5u`, non-RS256 algorithms and non-HTTPS remote key URLs.
- Validates signature, issuer, audience, expiry, not-before, subject, organization scope, site scope and permission claims.
- Caches JWKS for five minutes and refreshes once when a token references an unknown key ID, supporting normal key rotation.
- Adds regression tests for valid tokens, invalid signatures, claim failures, unknown-key refresh and unsafe key URLs.
- Authenticated `GET`/`POST /api/v1/organizations/:organizationId/events` endpoints using the configured trusted bearer-token verifier and server-side organization/site/action authorization.
- Operational event payload validation, server-assigned actor/organization identity, bounded request/details sizes, and explicit unauthorized/forbidden/error responses.
- Configurable event persistence: transactional SQLite via `SPAIS_EVENTS_DB_PATH` (persistent single-host deployment) or append-only JSONL via `SPAIS_EVENTS_FILE` (pilot/development fallback).
- SQLite writes use explicit transactions, unique event IDs, WAL mode and `synchronous=FULL`; organization/site-scoped indexed reads return newest events first (up to 100).
- SQLite database files require a persistent access-controlled volume and managed backups/retention. SQLite is not a shared multi-host database; horizontally scaled deployments still require a shared transactional database service.
- Automated SQLite tests cover reopen persistence, organization/site isolation, result limits, duplicate-ID rollback and disabled configuration.
- Automated unit and HTTP integration tests for event validation, persistence, cross-tenant/site denial, permission denial, and resistance to client-supplied actor/tenant IDs.
- Bounded browser-local live-session history and operational event trail.
- Session start/stop, line-crossing, camera-health and operator count-reset events.
- Session summaries capture mode, line position, requested/actual resolution, totals, directions, duration, stop reason and retention metadata.
- Recent sessions panel with user-controlled deletion and graceful behavior when browser storage is unavailable.
- Tests for event validation, session persistence, deletion, corrupt storage and reset semantics.
- CI runs the new live-session test suite along with existing SPAIS/security suites.

## Not yet implemented or verified
- Production identity-provider integration, key rotation and operational secret management.
- Deployment-specific OIDC identity-provider configuration, identity lifecycle operations, emergency key revocation procedures and operational secret management.
- Organization CRUD and broader tenant administration workflows beyond the current site/camera/connector metadata registry.
- Signed connector telemetry ingestion with RSA proof, strict event payload schemas, five-minute timestamp window, per-connector nonce replay prevention, bounded metadata-only payloads, and append-only SQLite receipts. Recorder coverage is explicitly labelled `reported_not_independently_verified`; telemetry receipt does not prove a camera/NVR is actually recording.
- Authorized, site-scoped connector telemetry reads require trusted bearer identity plus `connector:read`; returned recorder coverage remains labelled as reported rather than independently verified.
- Connector public-key revocation/rotation workflows and production-grade rate limiting/abuse controls.
- Recorder-side recording coverage evidence.
- Incident lifecycle and SOP/policy governance.
- Governed model candidate evaluation, approval and promotion.
- Real-camera lab or customer pilot acceptance.

## Safety and integration rules
1. Preserve local-first processing; raw frames/video do not leave the customer environment by default.
2. Do not infer recorder health from browser camera health or a network ping.
3. Never trust tenant IDs or principal claims supplied only by the browser; tenant APIs require trusted server-side identity and authorization.
4. Treat operator feedback as candidate labels, not automatic ground truth.
5. Require independent evaluation, human approval, controlled rollout, monitoring and rollback for production model changes.
6. Report each capability as planned, implemented, automated-test passed, lab-verified, pilot-accepted or production-approved with evidence.

## Next implementation gate
1. Validate the lifecycle/audit and connector proof-of-possession flow with full CI and security review.
2. Configure a real trusted identity provider in a controlled environment and verify issuer, audience, tenant and permission claim mapping.
3. Complete connector key revocation/rotation, deployment-specific rate limiting, monitoring and abuse controls; verify signed telemetry in a controlled lab before treating any reported status as operational evidence.
4. Implement customer-controlled camera/NVR connector operation and recorder-side recording assurance; enrollment alone does not prove a camera is connected or recording.
5. Add incident/SOP governance and a governed learning lifecycle.
6. Configure backup/retention/monitoring for single-host SQLite; use a shared transactional database service for multi-instance deployments.
