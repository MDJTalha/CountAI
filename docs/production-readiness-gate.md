# CountAI production-readiness gate

This document separates code/CI evidence from browser, camera, privacy, and operational evidence. A green build is necessary but not sufficient for a production release.

## Gate 1 — Automated regression and build

- [ ] `npm ci` completes from the committed lockfile.
- [ ] `npm run build` succeeds with TypeScript checks enabled.
- [ ] CI runs every maintained regression suite: engine, detection enhancement, camera health, camera health history, PWA build artifacts, and server.
- [ ] The PWA service worker is emitted and detector chunk remains excluded from install-time precache.
- [ ] Review dependency audit output and resolve or document any actionable production vulnerability.
- [ ] Confirm the release commit has a green workflow on the default branch, not only on a pull request.

## Gate 2 — Browser workflow

Record browser/OS/version, build commit, test date, and outcomes in `docs/browser-validation-checklist.md`.

- [ ] Photo workflow covers supported and rejected formats/sizes, manual correction, CSV/PNG exports, and restored sessions.
- [ ] Large-photo analysis completes within an agreed time budget on a documented reference device.
- [ ] Live camera start/stop/restart, both crossing directions, no-crossing stationary scene, denied permission, disconnect, stall, and recovery are exercised.
- [ ] Long-run test checks memory growth, inference latency, duplicate animation loops, and UI responsiveness.
- [ ] PWA update behavior is tested after a new version is deployed.

## Gate 3 — Model quality and performance

- [ ] Build a small, licensed/consented evaluation set representative of intended use.
- [ ] Measure per-class precision/recall and false detections separately for photo and live-camera paths.
- [ ] Record image dimensions, device/browser, model version, confidence thresholds, and inference time.
- [ ] Define acceptable thresholds before tuning; do not lower confidence thresholds without measuring false positives.
- [ ] Document the supported COCO-SSD class list and state that unsupported classes are not recognized.
- [ ] Test low-light, small/distant objects, occlusion, and crowded scenes; document known limitations.

## Gate 4 — Privacy and security

- [ ] Confirm images/video are processed locally by default and verify outbound network requests in DevTools.
- [ ] Verify no images, frames, or identifying information are written to logs or sent to the unconfigured cloud recognition endpoint.
- [ ] Review browser storage contents, export contents, retention, and user-visible deletion behavior.
- [ ] Review HTTPS deployment, security headers, content types, API behavior, dependency risk, and error responses.
- [ ] Document permissions and the fact that camera access is browser/device scoped; do not claim NVR/DVR recording assurance.
- [ ] Ensure production secrets are not shipped to the browser bundle.

## Gate 5 — Release and operations

- [ ] Define supported browsers/devices and minimum system requirements.
- [ ] Define versioning, release notes, rollback steps, incident contact, and issue-reporting process.
- [ ] Verify hosting serves the built `dist/` artifact over HTTPS and SPA/PWA routes work.
- [ ] Confirm cache update/invalidation behavior and recovery after failed/stale service-worker updates.
- [ ] Run a controlled pilot with consent, acceptance criteria, a named owner, and a rollback plan.
- [ ] Record go/no-go decision and any explicitly accepted risks.

## Current product boundary

CountAI currently uses browser-attached cameras and local COCO-SSD detection. Camera health represents the browser stream, not recorder-side recording completeness. Offline app-shell loading does not prove offline AI inference. Line-crossing events are estimates and are not guaranteed unique-person counts.

Do not mark any gate complete without a recorded observation or automated result. Do not include private surveillance images or faces in issue attachments.
