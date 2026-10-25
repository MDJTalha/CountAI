# CountAI — CCTV-first Surveillance & Operational Intelligence

CountAI is being developed as a customer-controlled, CCTV-first operations platform. The primary product workflow is network camera and recorder integration—not photo upload and photo counting.

## Product direction

- Connect authorized IP cameras and customer-managed NVR/DVR systems through supported streams, vendor APIs, or a customer-controlled edge connector.
- Organize cameras by organization and site.
- Provide live monitoring, object detection/tracking, line-crossing counts, camera health, operational events, incidents, SOP governance, and recording-assurance reporting.
- Keep video within customer-approved network boundaries wherever practical.
- Distinguish inventory metadata, connector-reported state, observed video, and independently verified recording evidence.
- Do not identify people by face or infer identity from temporary tracking IDs.

## Current frontend state

The production entrypoint now renders `src/CctvFirstApp.tsx`, a responsive CCTV-first shell with:

- Overview and integration-readiness dashboard.
- Live-monitoring placeholder that explicitly reports `NO VERIFIED STREAM` until a real stream adapter exists.
- Sites, cameras, connectors, and operational events workspace using the existing authenticated APIs.
- Incident/SOP, recording-assurance and AI governance workspace.
- A governed learning workbench for authorized documents, reference images, human observations/corrections, and short video clips exported from customer-controlled recorders.
- Tenant/site-scoped learning-source API, content hashes, restricted local media storage, consent confirmation, source status, and append-only ingestion audit records.
- Clear boundaries for IP cameras, NVR/DVRs, ONVIF and RTSP/vendor API integrations.

The legacy photo-counting component remains in the repository for now but is no longer the primary application entrypoint. Its UI and local-camera counting must not be represented as network-camera/NVR integration.

## Important integration boundary

The CCTV-first frontend does **not** yet mean that arbitrary cameras can be connected directly. A real deployment needs a compatible video or metadata path:

- **RTSP:** commonly used for camera/NVR video streams; browser playback normally requires a suitable gateway/decoder or server/edge adapter.
- **ONVIF:** device discovery/control and supported media profiles where the device supports them; compatibility varies by vendor and model.
- **Vendor NVR/DVR APIs:** needed where a recorder exposes proprietary access or playback functions.
- **HTTPS/HLS/WebRTC:** usable only when the camera/recorder or an approved gateway exposes a compatible endpoint.
- **Wi-Fi/Ethernet:** network transports; they do not by themselves establish an application-level video stream.
- **Bluetooth:** generally useful for provisioning, not continuous CCTV video transport.

The system must not perform unauthorized network scanning, guess camera credentials, expose RTSP credentials in the browser, or claim that a camera is online merely because an inventory record exists. Prefer customer-controlled outbound connector traffic and read-only recorder permissions.

## Architecture

- `src/CctvFirstApp.tsx`: primary CCTV-first operator shell.
- `src/CctvFirstApp.css`: responsive application layout.
- `src/SpaisOperationsWorkspace.tsx`: authorized organization/site inventory, connector enrollment, and operational-event views.
- `src/SpaisGovernanceWorkspace.tsx`: incident/SOP workflow, recording-assurance reports, and governance.
- `src/LiveCounter.tsx`: legacy browser-attached camera counting component; not yet the network-stream monitor.
- `src/engine/countingCore.mjs`: shared tracking/counting and line-crossing helpers.
- `server/index.mjs`: API entrypoint and route integration.
- `server/spais/`: contracts, authorization, operational events, connector telemetry, recording assurance, incidents, SOPs and learning governance.
- `server/spais/learningSources.mjs`: authorized learning-source validation, media storage, content hashing, and ingestion audit records.
- `src/SpaisLearningLab.tsx`: learning-source upload/observation workbench and model-candidate/evaluation governance.
- `connector/agent.mjs`: customer-side connector agent and telemetry delivery.

## Development

Node.js 20+ is recommended.

```bash
npm ci
npm run dev
```

Build the production application:

```bash
npm run build
npm run server
```

## Counting benchmark evaluator

A reproducible crossing-event metric harness is available in [the counting benchmark guide](docs/COUNTING_BENCHMARK.md). It reports event matching and count-error metrics from reviewed ground truth and model predictions; it does not assert production accuracy without representative held-out clips and agreed thresholds.

## Deployment

The `Publish CountAI container` workflow can publish reviewed `v*` releases to GitHub Container Registry after the full regression suite passes. See the [deployment runbook](docs/DEPLOYMENT_RUNBOOK.md) for pinning a release image and rolling back.

A hardened single-host Docker/Compose deployment package and operator runbook are available in [Production Deployment Runbook](docs/DEPLOYMENT_RUNBOOK.md). Start with `.env.example`, replace all identity-provider placeholders, and keep the service behind a managed HTTPS gateway. The Compose configuration binds the application to loopback and persists SQLite and backups in separate volumes. A packaged container is not a live deployment or proof of camera/NVR integration; follow the runbook and acceptance gates before production sign-off.

## Backup and scheduled maintenance

Use the [backup export and maintenance guide](docs/OPERATIONS_BACKUP.md) to export verified SQLite snapshots to a separately managed mount and schedule retention/backup jobs. Treat an export as successful only when the helper exits zero and records its SHA-256 digest. Learning media needs a coordinated backup plan as well; database-only backup is not complete disaster recovery.

## Acceptance evidence

Use [the system acceptance evidence matrix](docs/ACCEPTANCE_EVIDENCE_MATRIX.md) to record deployment-specific proof for browser acceptance, tenant/site isolation, real camera/NVR integration, counting accuracy, backup/restore, and governed learning. A green CI run is not a substitute for these environment-specific gates.

## Validation

```bash
npm run test:cctv-first-frontend
npm test
```

The CCTV-first source-contract test checks the entrypoint, navigation, honest stream status, integration wording, responsive layout, and documentation. CI/build success is not a substitute for browser acceptance or a real-camera integration pilot.

## Autonomous learning — current implementation boundary

The first learning-data ingestion stage supports:

- Text, Markdown, CSV, JSON and PDF document uploads (up to 8 MiB per file); text formats are indexed as text, while PDF files are stored for later extraction/review.
- PNG, JPEG and WebP reference images (up to 8 MiB) with file-signature checks and SHA-256 hashes.
- Human observation/correction notes with optional camera ID, timestamp and labels.
- Short MP4/WebM clips exported from authorized recorders (up to 8 MiB), stored on the customer-controlled host.
- Organization/site authorization, explicit upload authorization, bounded inputs, local file permissions, metadata-only listings, and ingestion audit entries.

Ingested sources are queued for human review/annotation; they are **not automatically trusted training labels**. This stage does not yet extract text from PDFs, run image/video inference on uploaded media, continuously record a live network camera, or train/promote a model. Live recording requires the separate authorized camera/recorder stream adapter. Continuous model improvement requires the next stages: annotation and dataset versioning, training workers, a reproducible deep-learning/ML pipeline, independent holdout evaluation, drift monitoring and governed model promotion. Existing model-candidate/evaluation APIs provide a proposal/evaluation governance boundary, not a training engine.

## Phase 1 foundation hardening

The API now has baseline response security headers, opt-in HSTS for deployments that enforce HTTPS at the public edge, bounded configurable process-local API rate limits, and bounded HTTP header/request/keep-alive timeouts. Security-control unit and HTTP integration tests are included in CI and `npm test`.

Operational configuration, data-retention policy requirements, recovery gates, and production limitations are documented in [Phase 1 Foundation Security](docs/PHASE1_FOUNDATION_SECURITY.md). Important limitations remain: the in-memory limiter is not distributed across server replicas; learning-source expiry runs only when the maintenance command is scheduled; production OIDC/secret lifecycle, TLS gateway configuration, backup/restore drills, and independent security assessment still require deployment-specific work.

## Remaining implementation gates

1. Implement a real camera/recorder adapter with an explicit supported-protocol contract.
2. Validate at least one customer-approved IP camera or NVR/DVR model end-to-end.
3. Add authenticated stream/session lifecycle APIs and server-side authorization.
4. Connect live video to inference and tracking with measured latency, dropped-frame handling, and reconnect behavior.
5. Validate multi-camera operator UI, camera health, event generation, recording assurance and incident/SOP workflows.
6. Complete threat modeling, credential handling, retention, observability, backup/recovery and deployment hardening.

Recording assurance remains `reported_not_independently_verified` until evidence is independently checked against the recorder. Signed connector telemetry is not proof that footage exists or is retrievable.
