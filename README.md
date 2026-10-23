# CountAI by AIVON — hybrid application scaffold

React + TypeScript + Vite PWA with a browser-local object detector, a shared counting/tracking core, IndexedDB session storage, and an explicitly unconfigured cloud-recognition adapter.

## Current implementation
- React/TypeScript mobile-first interface; responsive photo upload, camera capture, image annotations, category totals, manual add/edit/delete, CSV and annotated PNG export.
- TensorFlow.js + COCO-SSD Lite MobileNetV2 for local object detection. First use requires downloading library/model assets; the PWA caches the app shell but does not claim offline inference.
- Shared counting functions: totals by category, IoU matching, adjacent-frame track IDs, and line-crossing event helper.
- IndexedDB local history via `idb`.
- PWA manifest and generated service worker through `vite-plugin-pwa`.
- Cloud recognition client adapter validates structured detection results. Server endpoint deliberately returns HTTP 501 until a provider is configured; no fake cloud success.
- No facial identification or biometric identity matching.

## Requirements
Node.js 20+ recommended. Use a current npm release.

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
- `src/storage/sessions.ts`: IndexedDB local sessions.
- `server/index.mjs`: minimal static server and explicit unconfigured cloud endpoint.

## Important limits / unfinished work
1. COCO-SSD only recognizes its supported pretrained classes. Free-form phrases are currently a simple label filter, not open-vocabulary vision. `count red bottles`, shape recognition and arbitrary custom objects are not yet implemented as reliable capabilities.
2. The tracker helper is implemented and tested independently, but live-video continuous detection UI, normalized line/zone setup, direction filters and robust long-occlusion re-identification are not yet wired into the product screen. IoU tracking can switch IDs during overlap/crowding.
3. Cloud API provider/model, authentication, rate limiting, image-retention policy, schema integration and deployment are intentionally unconfigured. `/api/recognize` returns 501, not fabricated results.
4. The app UI currently uses Google Fonts over the network; self-host fonts for fully offline/strict privacy distribution.
5. No real image inference benchmark has been run in this environment: external package/model download availability is unverified. Unit tests validate the shared counting logic only, not detector accuracy.
6. Review upstream model/library licensing and pin/host dependencies and model weights before commercial production use.

## Privacy and security notes
- Images are processed locally by the browser detector by default. The optional cloud adapter only sends an image when explicitly called; the current UI does not call it.
- Do not add provider API keys to Vite `VITE_*` variables or browser code. Configure them only in a protected backend environment.
- Validate upload size and MIME type client-side and repeat validation server-side before enabling cloud recognition.
- Before production: add CSP, secure headers, dependency audit, rate limits, upload limits, deletion/retention rules, and a documented threat model.
