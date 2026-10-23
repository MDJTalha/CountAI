# CountAI browser and device validation checklist

Purpose: validate the production build in a real browser without treating automated unit tests as proof of camera or offline behavior.

## Test record

- Build commit:
- Date/time and timezone:
- OS and version:
- Browser and version:
- Camera/device:
- Build URL (localhost/HTTPS):
- Tester:
- Result: PASS / FAIL / BLOCKED

Do not record faces, footage, credentials, or other private surveillance data in issue attachments. Record outcomes and sanitized console errors only.

## A. First load and navigation

- [ ] Open the production preview at localhost or HTTPS; no blank screen or uncaught console errors.
- [ ] Navigate Live Counter → Photo Counter & Review → History; each workspace is reachable and navigation remains responsive.
- [ ] Reload each workspace and verify no crash.
- [ ] Confirm no video or image is uploaded to an unconfigured cloud recognition endpoint; cloud recognition is intentionally not configured.

## B. Photo workflow

- [ ] Load a supported JPG, PNG, WebP, or AVIF image below 12 MB.
- [ ] Reject an unsupported file type and an image larger than 12 MB with a clear message.
- [ ] Run local detection and verify the result canvas renders.
- [ ] Add a manual detection; verify category totals update.
- [ ] Edit a detection and remove a detection; verify totals update after each operation.
- [ ] Export CSV and annotated PNG; open each exported file and confirm it is non-empty.
- [ ] Reload the app, open History, restore a saved session, and verify counts and categories persist.
- [ ] Verify that restoring a session explains that the original image must be reselected to show annotations.

## C. Live camera lifecycle

Use a camera and a consenting test scene. Keep the camera fixed and use a clear, repeatable walking path across the counting line.

- [ ] Start the camera after granting browser permission; preview, line, label and status are visible.
- [ ] Confirm the reported resolution matches the camera's actual negotiated resolution.
- [ ] Cross line A → B several times; count increments once per valid crossing.
- [ ] Cross B → A; reverse-direction count increments separately.
- [ ] Stand still without crossing; count does not continually increase.
- [ ] Pause/resume, then stop; stream indicator stops and the camera indicator is released.
- [ ] Start again; preview and detections recover without duplicate animation loops.
- [ ] Change resolution while running; camera restarts and status reports the negotiated result.
- [ ] Deny camera permission (or test in a browser profile where it is denied); app shows a useful error and photo workflow remains available.
- [ ] Disconnect/disable the camera or end its track; health state reflects loss of frames/connection and does not label an empty scene as a camera failure.
- [ ] Restore the camera and restart; detections and counting resume.
- [ ] Observe a long enough run to detect memory growth, frozen preview, duplicate loops, or escalating inference latency.

Accuracy note: line-crossing events are estimates, not guaranteed unique-person counts. Occlusion, crowding, major camera movement, and track reassignment can affect accuracy.

## D. PWA install, cache and offline behavior

Run this section only after the app has loaded successfully online at the same origin.

- [ ] DevTools → Application → Service Workers: a service worker is registered and active.
- [ ] DevTools → Application → Cache Storage: app shell/precache entries exist.
- [ ] Confirm the large `localDetector-*.js` file is not in the install-time precache.
- [ ] Start Live Counter online once so the detector chunk is successfully fetched; verify the `countai-detector-assets` runtime cache appears.
- [ ] Turn on browser offline mode and reload the app shell; the shell should open.
- [ ] With offline mode still on, try loading/starting the detector in a fresh page context. Record whether model weights and runtime assets are available; do not assume caching the JavaScript chunk also caches model weights.
- [ ] Restore network access and reload; app returns to normal without clearing user sessions.
- [ ] Verify an update does not leave a blank page or a stale worker loop.

Important: shell-offline success and offline AI inference are separate checks. The detector chunk may be cached after first use, while model weights or other runtime dependencies may still require network access.

## E. Evidence and exit criteria

For each failed item, record:
1. Step ID and exact reproducible sequence.
2. Expected behavior and actual behavior.
3. Browser/OS version and whether online/offline.
4. Sanitized console/network error text.
5. Whether the issue reproduces after a fresh reload.

Exit only when all non-blocked checks pass, reproducible defects are fixed, automated tests pass, and a physical camera test has been recorded. Do not mark production-ready based on CI or build output alone.
