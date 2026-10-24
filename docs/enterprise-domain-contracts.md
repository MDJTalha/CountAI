# Enterprise Domain and Security Contracts (Phase 2)

Status: design contract; not yet implemented as backend authorization or deployed APIs.

## Purpose

Define stable resource names, ownership boundaries, states, and authorization expectations before CountAI imports or reuses SPAIS services. These contracts are intentionally independent of database or web-framework choices.

## Core resource model

All IDs are opaque, non-empty identifiers. Timestamps are ISO-8601 UTC. Resource relationships are explicit; clients must not infer scope from display names.

### Organization
- `organizationId`
- `name`
- `status: active | suspended`
- `createdAt`

An organization is the top-level security boundary. A user or connector must not access another organization by changing an ID in a URL or request body.

### Site
- `siteId`
- `organizationId`
- `name`
- `timezone`
- `status: active | suspended`

Every site belongs to exactly one organization. Timezone is required for reporting and recording-coverage windows; timestamps stored in events remain UTC.

### Camera
- `cameraId`
- `organizationId`
- `siteId`
- `displayName`
- `sourceKind: browser | edge_connector`
- `capabilities: detection | stream_health | recorder_coverage`
- `state: configured | reachable | streaming | degraded | disconnected | unknown`
- `lastEvidenceAt`

Capabilities must be declared and backed by an adapter. A configured camera is not automatically reachable; a reachable camera is not automatically recording; recorder coverage is not available unless the recorder adapter provides verifiable evidence.

### Connector
- `connectorId`
- `organizationId`
- `siteIds[]` (explicit allowlist)
- `identityKeyId`
- `state: pending_enrollment | active | revoked | unhealthy`
- `softwareVersion`
- `lastHeartbeatAt`

Connector credentials and private keys are never returned to ordinary clients or written to logs. Enrollment and revocation must be auditable. A connector can only access explicitly enrolled sites and resources.

### Live session
- `sessionId`
- `organizationId?`, `siteId?`, `cameraId?` (optional for local-only mode; required for enterprise-managed sessions)
- `startedAt`, `endedAt?`
- `countingConfigVersion`
- `summary`
- `evidenceQuality: valid | partial | unknown`

Local-only sessions remain usable without a tenant account. Enterprise mode requires server-side scope validation and must not trust organization/site IDs supplied only by the browser.

### Incident
- `incidentId`
- `organizationId`, `siteId`, `cameraId?`
- `kind: camera_unavailable | inference_failure | recording_gap | policy_violation`
- `severity: info | warning | high | critical`
- `state: open | acknowledged | investigating | resolved | reopened`
- `firstObservedAt`, `lastObservedAt`
- `evidenceRefs[]`, `policyVersionId?`

An incident must include provenance-bearing evidence or an explicit unknown reason. A ping alone cannot resolve a recording-gap incident.

### Policy/SOP version
- `policyId`, `policyVersionId`
- `organizationId`
- `state: draft | review | approved | active | retired`
- `sourceRefs[]`, `effectiveAt?`, `expiresAt?`
- `approvedBy?`, `approvedAt?`

Policy suggestions remain drafts. Publication requires an authorized approval and conflict/scope validation. Rules are a restricted typed format, never arbitrary generated code.

### Model release
- `modelVersionId`
- `modelFamily`, `artifactDigest`
- `datasetVersionIds[]`
- `metrics`
- `state: candidate | evaluated | approved | canary | active | retired | rolled_back`
- `approvedBy?`, `approvedAt?`

A model version must identify its artifact and evaluation dataset. A candidate cannot become active solely because automated training completed.

### Audit event
- `auditEventId`
- `organizationId`
- `actorType: user | connector | system`
- `actorId?`
- `action`
- `resourceType`, `resourceId`
- `occurredAt`
- `correlationId`
- `outcome: success | denied | failure`
- `reasonCode?`

Audit events are append-only from the application's perspective. Sensitive credentials, raw frames, full tokens, and unnecessary personal data must not be embedded in audit payloads.

## Authorization contract

| Role | View assigned site | Operate counting | Manage camera/connector | Review/resolve incidents | Publish policy/model | Manage organization |
|---|---:|---:|---:|---:|---:|---:|
| Organization admin | Yes | Yes | Yes | Yes | Yes, with approval controls | Yes |
| Site admin | Assigned sites | Yes | Assigned sites | Yes | Draft/request approval only | No |
| Operator | Assigned sites | Yes | No | Acknowledge/annotate | No | No |
| Reviewer | Assigned sites | No by default | No | Review/resolve per policy | Approve only if explicitly delegated | No |
| Auditor | Read-only assigned scope | No | No | Read-only | Read-only | No |
| Connector service | Allowlisted resources only | Submit telemetry only | Own health/enrollment only | Submit evidence only | No | No |

This table is a target contract, not a claim that these roles are implemented today. Production authorization must be enforced server-side for every request.

## Mandatory security and contract tests

1. Unauthenticated enterprise API requests fail closed.
2. User from organization A cannot read, mutate, export, or delete organization B resources by changing path, query, or body IDs.
3. Site-scoped users cannot reach an unassigned site within their own organization.
4. Connector identity cannot access a site outside its enrollment allowlist.
5. Revoked connector credentials stop authorizing requests.
6. Browser-provided tenant scope is not treated as proof of authorization.
7. Every denied cross-scope attempt produces a safe audit event without exposing secrets.
8. Camera status `configured` or `reachable` cannot be represented as verified recording coverage.
9. Missing recorder evidence yields `unknown` or an explicit error, not a false healthy state.
10. Draft or expired SOPs cannot trigger active policy decisions.
11. Model candidates cannot be promoted without required evaluation and approval evidence.
12. Resource deletion/export respects retention and ownership rules and is itself auditable.

## API and integration rules

- Version external contracts under `/api/v1`.
- Validate request and response schemas at the service boundary.
- Use server-derived authenticated scope, then intersect it with resource ownership and connector allowlists.
- Use idempotency keys for connector telemetry and incident creation where retries are expected.
- Include `correlationId` across connector, API, incident, and audit records.
- Keep SPAIS and CountAI independently buildable until these contracts have contract tests and a versioned API boundary.
- Keep raw video/image processing local by default. Any export must be explicit, authorized, bounded, and auditable.

## Phase 2 exit gate

Phase 2 is complete only when these contracts are implemented at the backend boundary, the negative authorization tests pass against a real test service, audit behavior is verified, and local-only CountAI still works without enterprise credentials. This document alone is design work, not security certification.
