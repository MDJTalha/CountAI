# CountAI / SPAIS Frontend Acceptance Checklist

This checklist is the browser-level acceptance gate for the unified frontend. CI build/regression success is necessary but does not replace these checks against a running application and configured test identity.

## Test environment

- [ ] Use a non-production environment and a dedicated test organization.
- [ ] Use two test organizations with separate sites and resource records.
- [ ] Use least-privilege test identities for operator, reviewer, and administrator workflows.
- [ ] Use synthetic metadata and approved test imagery only; do not paste secrets into incident/SOP descriptions.
- [ ] Confirm the server has a configured identity provider and persistent SQLite path.

## Navigation and responsive behavior

- [ ] On the active CCTV-first entrypoint, navigate Overview, Live monitoring, Sites & cameras, and Incidents & AI using keyboard and pointer.
- [ ] On initial keyboard navigation, confirm the visible “Skip to main content” link bypasses the sidebar and moves focus to the main workspace; verify the destination retains a visible focus indicator.
- [ ] Confirm the selected navigation item is announced and visibly identifiable, including its current-page state.
- [ ] Test desktop, tablet, and narrow mobile widths; ensure forms, tables, status labels, and actions remain usable without unintended horizontal overflow.
- [ ] Verify loading, empty, success, validation, permission-denied, network-error, and server-error states.
- [ ] Verify modal dialogs can be opened, completed, cancelled, and closed using keyboard controls.
- [ ] Run the counting/photo/history workflows only in the explicitly configured counting workspace or entrypoint under test; do not infer their availability from the CCTV-first navigation.

## Counting and local history

- [ ] Upload supported JPG, PNG, WebP, and AVIF images; reject unsupported formats and files above the documented limit.
- [ ] Run local detection and confirm the UI identifies outputs as model predictions requiring review.
- [ ] Add, edit, and remove manual detections; confirm category totals update.
- [ ] Export CSV and annotated PNG when applicable.
- [ ] Deny camera permission and verify a clear error plus photo-upload fallback.
- [ ] Confirm saved browser history restores counts without falsely implying the original image is still available.
- [ ] Test IndexedDB unavailable/corrupt behavior and confirm the app fails gracefully.

## Organization, site, and identity scope isolation

- [ ] Load records for organization A / site A, then change to organization B. Confirm all records, coverage assessments, enrollment challenges, and learning/evaluation results from the previous scope disappear immediately.
- [ ] Change the active site while a request is in flight. Confirm late responses from the old site do not repopulate the UI.
- [ ] Change the bearer token while a request is in flight. Confirm old identity data and late success/error responses are ignored.
- [ ] Confirm bearer tokens never appear in URLs, localStorage, IndexedDB, or browser history.
- [ ] Confirm unauthorized cross-organization/site requests are rejected by the server even if a user modifies frontend state manually.

## Sites, cameras, and connector enrollment

- [ ] Load authorized sites, cameras, connectors, and site-scoped operational events.
- [ ] Register site/camera/connector inventory metadata and verify the UI clearly states that registration does not prove device connectivity.
- [ ] Generate a connector enrollment challenge using a public RSA JWK only.
- [ ] Confirm the UI never asks for or stores the connector private key.
- [ ] Change organization, site, connector, or identity during enrollment and confirm a stale challenge is removed.
- [ ] Confirm expired/reused challenges and revoked/unregistered connectors are rejected by the server.

## Incidents, SOPs, recording assurance, and learning

- [ ] Create and refresh incidents; verify required audit notes and permitted status transitions.
- [ ] Create an SOP draft, submit it for review, and test approval with a separate authorized reviewer.
- [ ] Confirm approval failures are shown without implying that a version was approved.
- [ ] Query recording coverage with a valid bounded time window; confirm the UI labels it as report-based, not independently verified footage.
- [ ] Register a learning proposal with valid artifact and dataset SHA-256 identifiers.
- [ ] Review signed evaluation reports and confirm passing thresholds are not presented as production approval.
- [ ] Change scope during incident/SOP/coverage/learning requests and confirm stale results and stale errors do not overwrite the current workspace.

## Release gate

- [ ] Current feature branch passes required regression suites, TypeScript production build, and PWA service-worker verification.
- [ ] Browser acceptance evidence is recorded for supported browsers and viewport sizes.
- [ ] No real-recorder or production-readiness claim is made until the corresponding external validation has passed.
- [ ] Pull request remains unmerged until explicitly approved.
