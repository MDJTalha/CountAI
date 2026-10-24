# SPAIS integration status — CountAI codebase

## Product direction
CountAI is being evolved into SPAIS in the existing React/TypeScript/Vite PWA. Preserve existing counting and local review while adding enterprise surveillance and operational workflows incrementally.

## Implemented on `main`
- SPAIS product identity and operations-oriented dashboard foundation.
- Versioned API contract manifest at `GET /api/v1/spais/contracts`.
- Server-side resource-envelope validation and deny-by-default organization/site/action authorization helpers.
- Configurable HS256 bearer-token verification requiring a server-side secret, issuer and audience; checks signature, expiry, issuer, audience and tenant claims. It does not issue tokens or replace an identity provider.
- Tenant resource routes intentionally fail closed with `503 tenant_api_not_enabled`; trusted identity wiring and persistence are not yet active.
- Regression coverage for contract versioning, malformed resource IDs, cross-organization/site denial, action permissions, token verification and disabled tenant routes.

## Implemented in the current open PR
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
- Trusted principal wiring into active tenant CRUD routes.
- Durable server-side organization/site/camera/connector persistence and database migrations.
- Customer-controlled edge connector enrollment and camera/NVR inventory.
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
1. Validate the authenticated operational-event API and SQLite persistence changes with the complete CI suite and fix reproducible failures.
2. Configure persistent SQLite storage, backups, retention and operational monitoring for single-host pilots; select a shared transactional database for multi-instance deployments.
3. Integrate a production identity provider, key rotation and operational secret management.
4. Add durable organization/site/camera/connector persistence and negative isolation tests.
5. Design customer-controlled connector enrollment and recorder-side recording assurance.
6. Add incident/SOP governance and a governed learning lifecycle.
