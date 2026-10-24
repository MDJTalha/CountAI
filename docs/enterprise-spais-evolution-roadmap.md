# CountAI + SPAIS: Gradual Enterprise Evolution Roadmap

## Mission

Evolve CountAI from a local-first counting application into a customer-controlled CCTV intelligence platform, while reusing proven SPAIS governance and recording-assurance capabilities only after they pass integration and security gates.

This roadmap is incremental. Each phase must deliver a testable, reviewable slice. Do not merge large SPAIS feature stacks into CountAI wholesale.

## Non-negotiable architecture and product boundaries

1. **Local-first by default.** Raw frames, images, and video remain in the customer's environment unless an explicitly authorized workflow says otherwise.
2. **No hidden network access.** Camera/NVR access is initiated by a customer-approved edge connector with explicit destinations, credentials, capabilities, and revocation.
3. **Separate evidence states.** Camera reachability, live-stream health, inference health, recorder reachability, recording coverage, and counting quality are distinct signals. Never infer one from another.
4. **Tenant isolation on the server.** UI filtering is not authorization. Every server-side read/write must enforce organization/site/resource scope.
5. **Governed learning.** Feedback may generate candidate recommendations or datasets; production model, threshold, and SOP changes require evaluation, provenance, approval, monitoring, and rollback.
6. **No identity recognition by default.** CountAI remains focused on supported object detection and counting, not face identification or biometric identity matching.
7. **Evidence over claims.** CI is not proof of camera/NVR behavior, offline inference, model accuracy, or production readiness.

## Current baseline

- React + TypeScript + Vite PWA, local COCO-SSD detector, counting/tracking helpers, IndexedDB photo-session storage, CSV/annotated-PNG exports.
- Overview, Live Counter, Photo Review, History, and Analytics workspaces are present on CountAI main.
- Prediction labels and opt-in confidence display reduce overclaiming but do not improve model accuracy.
- Current detector supports only its pretrained classes. User corrections are not model training.
- Live camera support is browser-attached camera scope; it is not RTSP/ONVIF/NVR integration or recorder-side recording assurance.
- PWA app-shell caching does not prove offline model/runtime/weights availability.
- SPAIS has a richer Phase 3 feature branch and an open draft operator-console integration PR (#40), but the PR's notes report GitHub Actions jobs failing before steps execute (steps: null) and no retrievable logs. Those changes must not be treated as runtime-validated or production-ready.

## Phase 0 — Establish an honest, reproducible baseline

**Deliverables**
- Keep a single source-of-truth checklist for tests, browser workflows, camera tests, privacy, model quality, and release operations.
- Record exact commit, environment, commands, and results for each validation run.
- Verify all main-branch test scripts and default-branch CI before new integrations.
- Review the current UI with the browser checklist; capture usability issues without storing surveillance footage or personal data.

**Exit criteria**
- Clean install and production build pass.
- All maintained automated suites execute and pass on the exact candidate commit.
- Browser checklist records PASS/FAIL/BLOCKED with environment details.
- Any unavailable CI runner or missing logs is reported as an infrastructure blocker, not an application test pass.

## Phase 1 — Operational events and live-session history

**Goal:** make live counting reviewable and analytics truthful before adding enterprise infrastructure.

**Deliverables**
- Define a versioned event contract for live_session_started, live_session_stopped, crossing_counted, camera_health_changed, inference_health_changed, and operator_correction.
- Persist a user-controlled live-session summary locally, including start/end, configured counting line/direction, count totals, health transitions, app/model version, and explicit data-quality limitations.
- Do not store raw frames or video by default.
- Separate manual_additions, edits_to_ai_predictions, deletions, and confirmed_crossings in analytics; do not call all manual detections “corrections.”
- Add migration-safe storage, export, deletion, and regression tests.
- Make dashboard status copy explicit: browser camera only; recorder status unavailable unless a recorder integration supplies evidence.

**Exit criteria**
- Repeated start/stop/reload does not create duplicate sessions or counting events.
- Stored summaries can be exported and deleted by the user.
- Analytics labels match the underlying event semantics.
- Existing photo workflows and PWA tests remain green.

## Phase 2 — Enterprise domain and security contracts

**Goal:** establish safe organization/site/resource boundaries before adding a multi-user backend.

**Deliverables**
- Document shared identifiers and schemas for organization, site, camera, connector, live session, incident, policy, model version, and audit event.
- Define tenant-scoped API authorization, role matrix, retention rules, audit requirements, and data-flow threat model.
- Select the minimum SPAIS APIs/contracts to reuse; keep CountAI frontend independent of SPAIS implementation details.
- Add contract tests and explicit API versioning.
- Keep the current local-only mode working without an account or cloud service.

**Exit criteria**
- Cross-tenant access tests fail closed.
- No UI-only authorization assumptions.
- Data-flow, threat model, and retention defaults reviewed.
- No SPAIS code is imported solely because it exists on a feature branch.

## Phase 3 — Customer-local connector and camera inventory

**Goal:** connect one explicitly authorized camera/NVR integration without requiring the customer's CCTV network to accept inbound access from an external service.

**Deliverables**
- Edge connector runs inside the customer's approved network boundary.
- Secure enrollment, unique connector identity, rotation/revocation, least privilege, outbound allowlist, signed/versioned updates, and auditable health.
- Start with one vendor-supported integration and a synthetic/test device.
- Validate URL/port handling, SSRF protections, timeouts, malformed responses, credentials handling, and network segmentation.
- Distinguish configured, reachable, streaming, inference-ready, and recorder-query-capable states.

**Exit criteria**
- Connector works on a controlled test network.
- Security tests execute on a functioning CI runner or documented isolated runner.
- No raw video leaves the site by default.
- A customer can revoke the connector and confirm access stops.

## Phase 4 — Recording assurance and incidents

**Goal:** verify recorder-side evidence independently of live stream health.

**Deliverables**
- Recorder adapters return typed, timestamped, provenance-bearing evidence with explicit unknown/error states.
- Calculate expected-versus-observed recording coverage using timezone-aware intervals and documented tolerances.
- Create deduplicated incidents with acknowledge, assign, investigate, resolve, and reopen transitions.
- Resolve a recording-gap incident only when recovery/coverage evidence meets the policy; never mark success from a ping alone.
- Audit all lifecycle transitions; notifications are opt-in, scoped, and retry-safe.

**Exit criteria**
- Synthetic timeline tests cover gaps, overlap, clock skew, daylight-saving boundaries, missing evidence, recorder outages, and recovery.
- Incident state transitions and duplicate handling are tested.
- A real recorder pilot confirms results against recorder UI/export evidence.

## Phase 5 — SOP and policy governance

**Goal:** reuse SPAIS's typed SOP/policy model without allowing generated code to execute.

**Deliverables**
- Ingest approved SOP documents with bounded extraction, source provenance, version, owner, and effective date.
- Translate rules into a restricted typed DSL.
- Keep generated suggestions in draft; validate scope and conflicts before authorized approval and publication.
- Link each operational alert to the policy version and evidence that caused it.
- Support expiry, rollback, and audit history.

**Exit criteria**
- Untrusted document text cannot execute code or modify policy by itself.
- Policy changes are versioned and attributable.
- Tests cover conflicting rules, stale versions, invalid scope, and revoked policies.

## Phase 6 — Governed autonomous learning

**Goal:** automate analysis and candidate improvement without uncontrolled production self-modification.

**Deliverables**
- Capture explicit operator feedback with provenance and separate AI predictions from human-confirmed labels.
- Create a privacy-aware dataset registry with retention, consent/authorization, class balance, and train/evaluation splits.
- Start with error analysis, drift alerts, and candidate threshold/configuration recommendations.
- Train a custom detector only when the desired classes, authorized examples, baseline metrics, and compute requirements are defined.
- Evaluate candidates on held-out data; report precision, recall, false positives, missed detections, latency, and per-scene performance.
- Promote via shadow/canary deployment, explicit approval, monitoring, and rollback.
- Keep customer datasets isolated unless cross-customer use is explicitly authorized and governed.

**Exit criteria**
- No unreviewed prediction is treated as ground truth.
- Model and dataset artifacts are versioned and reproducible.
- Candidate must meet pre-agreed metrics and regression limits.
- Rollback is tested and production model changes are auditable.

## Phase 7 — Unified operator console and customer pilot

**Goal:** present counting, camera health, recording assurance, incidents, SOP governance, and learning in one clear workspace.

**Deliverables**
- Navigation for Overview, Sites & Cameras, Live Counting, Recording Assurance, Incidents, SOPs, Analytics, Learning Lab, Audit, and Settings—only as each capability becomes real.
- Clear state vocabulary and evidence drill-downs; never show “healthy” where the state is unknown.
- Accessible responsive layout, role-aware controls, keyboard support, and useful empty/error/loading states.
- Pilot with named customer owner, consent, success criteria, support/incident plan, retention policy, and rollback.

**Exit criteria**
- Customer acceptance scenarios pass on supported hardware.
- Security/privacy and performance reviews are signed off.
- Recovery, upgrade, backup/restore, and rollback are exercised.
- Go/no-go decision records residual risks.

## Integration rules for SPAIS

- Keep SPAIS and CountAI repositories independently buildable until the API contracts stabilize.
- Reuse SPAIS concepts and tested modules selectively; do not merge its entire open PR stack.
- PR #40 in SPAIS is draft and has documented runner failures before test steps. Treat its code as unvalidated until the exact head runs the tests successfully.
- Validate one capability at a time: event contract, auth/tenant boundary, connector, recorder evidence, incident lifecycle, policy governance.
- Prefer a versioned API or small shared schema package over cross-repository imports of internal implementation modules.

## Execution status — 2026-10-24

| Work item | Status | Evidence / next gate |
|---|---|---|
| Phase 0: baseline and roadmap | In progress | Roadmap PR #16; local workstation pull and browser re-validation still require the user's machine |
| Phase 1A: versioned event contract | Implemented on feature branch; CI passed | [PR #17](https://github.com/MDJTalha/CountAI/pull/17); six focused contract tests pass in the stacked Phase 1B CI run |
| Phase 1B: local live-session summaries | Implemented on feature branch; CI passed | [PR #18](https://github.com/MDJTalha/CountAI/pull/18); bounded local storage, session/crossing/health events, recent-session UI, delete control, and five storage tests |
| Phase 1C: CI coverage for new suites | Added and verified | [Successful CI run](https://github.com/MDJTalha/CountAI/actions/runs/40058392307) explicitly executes `test:operational-events` (6 passing) and `test:live-sessions` (5 passing) |
| Phase 2: enterprise security contracts | Not started | Begin after Phase 1 PRs are reviewed and the baseline is synchronized |
| Phases 3–7 | Not started | Connector, recorder evidence, incident lifecycle, SOP governance, learner and pilot remain gated |

## Immediate next work item

Finish Phase 1 by confirming CI explicitly executes both new test suites, review the exact PR head, and keep the changes unmerged until that evidence is green. Then prepare Phase 2's versioned organization/site/camera/connector/incident/policy/model/audit contracts and tenant-isolation test matrix. Do not start real NVR access or model training before these foundations and their validation gates are in place.

Local browser validation is still required after the user pulls the accepted changes. A passing hosted build cannot prove real-camera behavior, offline inference, or visual usability.
