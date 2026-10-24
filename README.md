# SPAIS — Surveillance & Operational Intelligence

This repository evolves the CountAI React + TypeScript + Vite PWA into SPAIS. The application includes browser-local live camera counting/tracking, line-crossing counts, camera-health history, and browser-local session summaries. The server also provides authenticated tenant/site-scoped operational events, resource inventory, connector enrollment and telemetry, report-based recording assessment, incident/SOP governance, and signed learning-evaluation metadata APIs. These backend capabilities remain pilot-stage until deployment configuration, customer-host validation, and independent operational evidence are completed. Cloud recognition is intentionally unconfigured.

## Current implementation
- React/TypeScript mobile-first interface; responsive photo upload, camera capture, image annotations, category totals, manual add/edit/delete, CSV and annotated PNG export.
- TensorFlow.js + COCO-SSD Lite MobileNetV2 for local object detection. First use requires downloading library/model assets; the PWA caches the app shell but does not claim offline inference.
- Shared counting functions: totals by category, IoU matching, adjacent-frame track IDs, and line-crossing event helper.
- Live camera workflow in `src/LiveCounter.tsx`: browser `getUserMedia`, local detector loading, live tracking/overlays, configurable horizontal line position, bidirectional crossing counts, camera-health metrics/history, and start/pause/stop session lifecycle.
- Bounded browser-local live-session summaries and operational events; this is not server-side session storage.
- IndexedDB photo-session history via `idb`.
- PWA manifest and generated service worker through `vite-plugin-pwa`.
- Cloud recognition client adapter validates structured detection results. Server endpoint deliberately returns HTTP 501 until a provider is configured; no fake cloud success.
- No facial identification or biometric identity matching.

## Requirements
Node.js 22+ required for the server's built-in `node:sqlite` persistence adapter. Use a current npm release.

```bash
npm install
npm run dev
```

For a production bundle and local server:

```bash
npm run build
npm run server
```

Then open `http://localhost:8787`. On a phone, deploy behind HTTPS to enable installation and camera permission. Localhost is accepted for development.

## Test the counting core

```bash
npm run test:engine
```

## Architecture
- `src/engine/localDetector.ts`: replaceable browser inference adapter (COCO-SSD fixed classes).
- `src/engine/cloudRecognition.ts`: optional backend API adapter; the frontend contains no provider secret.
- `src/engine/countingCore.mjs`: shared totals, IoU association and line-crossing logic.
- `src/LiveCounter.tsx`: browser-local live camera detection, tracking, crossing counts, and camera-health UI.
- `src/storage/liveSessions.mjs`: bounded browser-local live-session history.
- `server/spais/`: versioned contracts, bearer-token/OIDC authentication, tenant-scoped resources, connector telemetry, recording-assurance assessment, incidents, SOP versions, audit events, and learning-evaluation attestations.
- `server/index.mjs`: static/PWA server plus authenticated SPAIS API routes and an explicit unconfigured cloud-recognition endpoint.

## Important limits / unfinished work
1. COCO-SSD only recognizes its supported pretrained classes. Free-form phrases are currently a simple label filter, not open-vocabulary vision. `count red bottles`, shape recognition and arbitrary custom objects are not yet implemented as reliable capabilities.
2. Browser live-camera continuous detection, IoU tracking, a configurable horizontal counting line, and bidirectional crossing counts are wired into `LiveCounter`. Limitations remain: the camera input is browser `getUserMedia`, not RTSP/ONVIF/NVR ingestion; there are no arbitrary multi-zone/multi-line rules; and IoU tracking can switch IDs during overlap/crowding or long occlusions.
3. Cloud API provider/model, authentication, rate limiting, image-retention policy, schema integration and deployment are intentionally unconfigured. `/api/recognize` returns 501, not fabricated results.
4. The app UI currently uses Google Fonts over the network; self-host fonts for fully offline/strict privacy distribution.
5. No real image inference benchmark has been run in this environment: external package/model download availability is unverified. Unit tests validate the shared counting logic only, not detector accuracy.
6. Review upstream model/library licensing and pin/host dependencies and model weights before commercial production use.
7. SPAIS connector and recording assurance are pilot-stage. The connector consumes one explicitly configured customer-approved JSON recorder-status endpoint; vendor-specific recorder adapters and a customer-controlled physical recorder test are still required. Coverage remains `reported_not_independently_verified` and is not proof that footage exists or is retrievable.
8. Server-side tenant APIs require trusted identity configuration and persistent SQLite. SQLite is single-host storage; multi-host production needs a shared transactional database, managed backups/retention, monitoring, rate limits, and a security review.

## Privacy and security notes
- Images are processed locally by the browser detector by default. The optional cloud adapter only sends an image when explicitly called; the current UI does not call it.
- Do not add provider API keys to Vite `VITE_*` variables or browser code. Configure them only in a protected backend environment.
- Validate upload size and MIME type client-side and repeat validation server-side before enabling cloud recognition.
- Before production: complete CSP/security-header review, dependency audit, rate limits, upload limits, deletion/retention rules, and a documented threat model. CI/build success is not a substitute for browser/device testing, inference benchmarking, or a customer recorder pilot.
