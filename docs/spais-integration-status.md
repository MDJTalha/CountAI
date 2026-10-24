# SPAIS integration status — CountAI codebase

## Current integration branch
- Branch: `feat/spais-operator-console-foundation`
- Pull request: [#21 — SPAIS operator-console foundation](https://github.com/MDJTalha/CountAI/pull/21)
- Purpose: evolve the existing CountAI React/TypeScript PWA into SPAIS incrementally, preserving local counting and review.

## Implemented in the current branch
- SPAIS product identity and operations-oriented dashboard foundation.
- Existing browser-local photo detection, manual review, browser-attached live camera, local session history and analytics remain available.
- Versioned SPAIS API contract manifest at `GET /api/v1/spais/contracts`.
- Contract descriptors for organizations, sites, cameras, connectors, live sessions, incidents, SOP versions, model releases and audit events.
- Server-side resource-envelope validation and deny-by-default organization/site/action authorization helpers.
- Configurable HS256 bearer-token verifier requiring server-side secret, issuer and audience; checks signature, expiry, issuer, audience and tenant claims. It does not issue tokens or replace an identity provider.
- Tenant resource routes remain disabled with an explicit `503 tenant_api_not_enabled` until trusted identity integration, authorization wiring and persistent storage are configured.
- Regression tests cover contract versioning, invalid IDs, cross-organization denial, site-scope denial, action permissions, bearer-token verification, the manifest route and disabled tenant routes.
- CI is configured to run both `test:spais-contracts` and `test:spais-auth` with the existing suites.

## Not yet implemented or verified
- Production identity-provider integration, key rotation and operational secret management.
- Wiring verified token principals into active tenant CRUD routes.
- Persistent organization/site/camera/connector resource store and database migrations.
- Customer-controlled edge connector and camera/NVR inventory.
- Recorder-side recording coverage evidence.
- Incident lifecycle and SOP/policy governance.
- Governed model candidate evaluation, approval and promotion.
- Real-camera lab or customer pilot acceptance.

## Integration and safety rules
1. Preserve local-first processing; raw frames/video do not leave the customer environment by default.
2. Do not infer recorder health from browser camera health or a network ping.
3. Never trust tenant IDs or principal claims supplied only by the browser; tenant APIs require a trusted server-side identity and authorization adapter.
4. Treat operator feedback as candidate labels, not automatic ground truth.
5. Require independent evaluation, human approval, controlled rollout, monitoring and rollback for production model changes.
6. Report each capability as planned, implemented, automated-test passed, lab-verified, pilot-accepted or production-approved with evidence.

## Next implementation gate
1. Verify CI after the authentication test suite addition and fix reproducible failures.
2. Integrate a trusted identity provider and wire verified principals into tenant/site-scoped routes.
3. Add durable tenant persistence and negative isolation tests.
4. Integrate session and operational events with server persistence without silently replacing browser-local history.
5. Design customer-controlled connector enrollment and recorder-side recording assurance.
6. Add incident/SOP governance and a governed learning lifecycle.
