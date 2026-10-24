# Frontend browser acceptance checklist

This checklist supplements automated regression tests. Passing source-level tests and a production build does **not** mean browser acceptance has passed.

## Test environment

- [ ] Run `npm ci` and `npm test` on the branch being accepted.
- [ ] Start the API using the documented local configuration and `npm run server`.
- [ ] Start the UI using `npm run dev` or serve the production build with `npm run preview`.
- [ ] Use a test organization/site and a non-production identity. Never paste a production bearer token into screenshots, logs, or test evidence.
- [ ] Record browser/version, viewport, commit SHA, test date, and pass/fail evidence.

## Navigation and responsive layout

- [ ] At desktop width, each primary workspace is reachable: Overview, Live Counter, Photo Review, History, Analytics, Governance/AI/SOPs, Sites/Cameras.
- [ ] The selected workspace is communicated through the navigation control's pressed state.
- [ ] At 320px, 375px, 768px, and desktop widths, navigation remains reachable without page-wide horizontal overflow.
- [ ] Touch targets remain usable; keyboard focus is visible; reduced-motion preference is respected.
- [ ] Keyboard-only operation can reach all visible controls in a logical order.

## Photo counting and correction

- [ ] Unsupported image types and images over 12 MB show actionable errors.
- [ ] Upload a permitted sample image; run local detection; verify busy/loading and result states.
- [ ] Empty detections and unsupported target labels are not presented as proof that objects are absent.
- [ ] Open the correction dialog; verify initial focus, Tab/Shift+Tab containment, Escape close, and focus restoration.
- [ ] Reject empty categories and confidence values outside 0..1; accept valid manual corrections.
- [ ] Force local-history storage failure and verify the UI shows a save error rather than success.
- [ ] Verify totals, CSV export, and annotated PNG export after add/edit/remove corrections.

## Camera lifecycle and history

- [ ] Grant camera permission and verify preview starts; deny permission and verify a recoverable message.
- [ ] Stop camera and navigate away; verify all media tracks stop and no stale running status remains.
- [ ] Verify session history loads, opens, deletes, and gracefully handles unavailable/corrupt local storage.
- [ ] Confirm the elapsed timer and camera health state stop changing appropriately after stop/failure.

## SPAIS operations and security

- [ ] Without credentials, protected operations do not disclose site/camera/connector/event data.
- [ ] With a dedicated test identity, verify site/camera/connector inventory and event filters.
- [ ] Switch organization, site, or token while requests are in flight; old results must not repopulate the new scope.
- [ ] Test missing scope, unauthorized site, expired token, API error, malformed response, and network disconnect states.
- [ ] Verify connector enrollment challenge expiry and ensure private key material is never displayed or sent to the UI.
- [ ] Confirm recording coverage is labelled as reported and not independently verified unless recorder-side evidence was actually checked.
- [ ] Verify incidents, SOP transitions, learning proposals, and evaluation reports show loading, empty, success, and error states.

## Release evidence

- [ ] Attach redacted screenshots or recordings for desktop and mobile workflows.
- [ ] Link the exact green CI run and note any skipped/manual-only checks.
- [ ] Log failures as issues with reproduction steps; do not waive security or data-isolation failures.
- [ ] Mark browser acceptance complete only after the real browser/device run has been performed by an authorized tester.
