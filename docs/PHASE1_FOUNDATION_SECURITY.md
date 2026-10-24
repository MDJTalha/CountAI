# Phase 1 — foundation security and operations

Status: implementation in progress; merge/deployment and customer acceptance are intentionally separate gates.

## Runtime protections added

- Baseline response headers: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(self), microphone=(), geolocation=()`, `Cross-Origin-Opener-Policy: same-origin`, and `Cross-Origin-Resource-Policy: same-origin`. API JSON responses use `Cache-Control: no-store`; the HTML entry point and unhashed static assets use `no-cache`, while content-hashed build assets may be cached as immutable.
- Optional HSTS only when `COUNTAI_ENABLE_HSTS=true`. Enable only after HTTPS is guaranteed at the public edge, including all subdomains covered by the directive.
- Process-local API rate limits. Defaults are 120 API requests per minute and 30 write requests per minute per socket peer. `/api/health` is exempt so a load balancer can continue probing service health.
- Rate-limited requests return HTTP 429 with `Retry-After` and rate-limit headers.
- The limiter does not trust `X-Forwarded-For` by default. This prevents arbitrary clients from spoofing the key, but clients behind a reverse proxy may share the proxy's socket address.
- HTTP header, request and keep-alive timeouts are bounded; maximum request headers are capped at 100.

## Environment configuration

All controls have safe development defaults. Review these values against the deployment's traffic profile before production:

| Variable | Default | Purpose |
|---|---:|---|
| `COUNTAI_API_RATE_LIMIT` | `120` | API reads and general API request budget per window/client |
| `COUNTAI_WRITE_RATE_LIMIT` | `30` | POST/PATCH/PUT/DELETE budget per window/client |
| `COUNTAI_RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window in milliseconds |
| `COUNTAI_ENABLE_HSTS` | `false` | Add HSTS only when HTTPS is enforced externally |
| `COUNTAI_HEADERS_TIMEOUT_MS` | `15000` | Header receipt timeout |
| `COUNTAI_REQUEST_TIMEOUT_MS` | `120000` | Complete request timeout |
| `COUNTAI_KEEPALIVE_TIMEOUT_MS` | `5000` | Keep-alive timeout |
| `COUNTAI_LEARNING_SOURCE_RETENTION_DAYS` | `0` | Learning-source expiry days; `0` disables expiry |

The application should run behind a maintained TLS reverse proxy or managed gateway. For a multi-instance or public production deployment, enforce rate limits at a trusted shared gateway/WAF as well: this in-memory limiter is per process, resets on restart and is not a distributed quota service. Do not enable proxy-IP trust until the trusted proxy chain and header sanitization are explicitly configured.

## Authentication and tenant isolation

- Keep `SPAIS_AUTH_ISSUER`, `SPAIS_AUTH_AUDIENCE`, and either `SPAIS_AUTH_JWKS_URL` or `SPAIS_AUTH_HS256_SECRET` in the server secret manager, not in browser variables or committed files.
- Prefer the customer-approved OIDC/JWKS verifier for interactive enterprise identity. HS256 is suitable only when secret distribution and rotation are controlled.
- Do not expose a public login/token-issuing endpoint from this service; token issuance belongs to the configured identity provider.
- Every tenant API must use a verified principal and server-side organization/site/action checks. Negative tests must cover missing/expired tokens, wrong organization, wrong site, insufficient permission, revoked connector identity, spoofed actor/tenant fields and unknown resources.
- The contract manifest and health endpoint are deliberately non-sensitive. Health is not a readiness assertion for cameras, inference or recording.

## Data retention and deletion policy

Customer contracts and applicable law determine exact retention periods. Until a customer-specific retention schedule is approved and implemented, do not represent CountAI as automatically enforcing a universal retention period.

Required policy before production:
1. Define a retention class and approved period for each data type: uploaded source media, source text/metadata, operational events, incidents/evidence references, connector queues, security/audit events, backups and browser-local session history.
2. Keep raw CCTV/video in the customer-controlled environment by default. Uploading learning material requires explicit authorization; it must not be treated as an automatic training opt-in.
3. Provide an authorized deletion/export workflow for customer data and document the expected deletion window, backup expiry and legal-hold exception. The learning-source API now supports site-scoped `DELETE /api/v1/organizations/:organizationId/learning-sources/:sourceId?siteId=...` with the dedicated `model:manage` permission; deletion leaves a minimal audit entry; if media cleanup fails, the API returns a retryable error and preserves the source record for a later retry.
4. Preserve a minimal audit record of the deletion action without retaining the deleted media or sensitive source contents.
5. Verify deletion from primary storage, temporary files, derived datasets, caches and backups according to the approved retention policy.
6. Prevent deletion of required security/audit records by ordinary operators; restrict audit retention administration to a separately authorized role.
7. Test the deletion workflow, tenant isolation, concurrent access, interrupted cleanup and backup restoration.

**Current implementation boundary:** authorized server-side learning-source deletion and an opt-in retention-expiry maintenance command are implemented. Schedule `npm run maintenance:expire-learning-sources` with `SPAIS_EVENTS_DB_PATH` and an approved `COUNTAI_LEARNING_SOURCE_RETENTION_DAYS` value to enforce expiry. A value of `0` disables automatic expiry. The command is not a background scheduler by itself; deployment operations must schedule it and monitor its result. Browser-local live-session deletion is separate and does not delete server-stored learning media.

## Persistence and recovery

- SQLite is a single-host persistence option, not a shared database for horizontally scaled replicas.
- Set `SPAIS_EVENTS_DB_PATH` to a persistent, access-controlled volume and ensure the process account has only the required permissions.
- Back up the SQLite database using a consistent SQLite-aware backup procedure; copying an active database file without accounting for WAL state is not a sufficient recovery plan.
- Define and test RPO/RTO, encryption at rest, backup retention, restore drills, disk-capacity alerts and recovery after interrupted writes before production approval.
- For multi-instance deployment, use a shared transactional database and a separately designed migration/backup strategy.

## Reproducible validation

Use the Node.js version pinned in CI (Node 22) and the committed lockfile:

```sh
npm ci
npm test
npm run build
```

The CI pipeline must run all required test suites, including the security-controls unit and HTTP integration suites. A green CI run validates the configured automated checks; it does not replace a deployment-specific security review, physical camera/NVR test, load test or disaster-recovery drill.

## Phase 1 exit checklist

- [x] Add baseline HTTP security headers with explicit HSTS opt-in.
- [x] Add bounded, configurable process-local API rate limits and request timeouts.
- [x] Add regression tests for limits, headers, forwarded-header spoofing and health-probe behavior.
- [x] Include the new security suites in CI and the default test command.
- [x] Implement and test authorized site-scoped learning-source deletion and an opt-in retention-expiry maintenance command.\n- [ ] Configure and monitor the scheduled retention task with a customer-approved retention period.
- [ ] Configure production OIDC, secret rotation/revocation and trusted TLS gateway.
- [ ] Configure SQLite backup/restore and document verified RPO/RTO, or select a supported shared database.
- [ ] Run an independent security review and deployment-level load/recovery tests.
- [ ] Verify all open PRs against current main, merge only after review/CI, then repeat validation on main.

## Competitive recommendations

1. Offer a customer-controlled deployment profile (edge-only, single-host pilot, and enterprise shared-service) with explicit network/data-flow diagrams.
2. Make security and operational readiness observable: readiness probes, structured request IDs, rate-limit telemetry, dependency alerts, audit export and clear degraded states.
3. Publish a support matrix for tested camera/NVR models and protocol versions rather than broad unverified compatibility claims.
4. Measure counting quality on held-out, customer-authorized footage and publish scenario-specific precision/recall/counting error and latency.
5. Build privacy-first governance into the product: retention labels, consent/provenance, operator-reviewed annotations, dataset lineage and explicit model-release approval.
6. Treat backup restoration, upgrade/rollback, and customer acceptance as automated release gates, not documentation-only promises.
