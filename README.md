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

## Validation

```bash
npm run test:cctv-first-frontend
npm test
```

The CCTV-first source-contract test checks the entrypoint, navigation, honest stream status, integration wording, responsive layout, and documentation. CI/build success is not a substitute for browser acceptance or a real-camera integration pilot.

## Remaining implementation gates

1. Implement a real camera/recorder adapter with an explicit supported-protocol contract.
2. Validate at least one customer-approved IP camera or NVR/DVR model end-to-end.
3. Add authenticated stream/session lifecycle APIs and server-side authorization.
4. Connect live video to inference and tracking with measured latency, dropped-frame handling, and reconnect behavior.
5. Validate multi-camera operator UI, camera health, event generation, recording assurance and incident/SOP workflows.
6. Complete threat modeling, credential handling, retention, observability, backup/recovery and deployment hardening.

Recording assurance remains `reported_not_independently_verified` until evidence is independently checked against the recorder. Signed connector telemetry is not proof that footage exists or is retrievable.
