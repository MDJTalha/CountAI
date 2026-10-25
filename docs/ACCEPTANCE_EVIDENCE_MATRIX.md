# CountAI — system acceptance evidence matrix

## Purpose

Use this matrix to reconcile engineering checklists with evidence from the exact build and deployment being accepted. A checked box or passing unit test is not, by itself, proof of end-to-end acceptance.

Record each gate as one of:

- **PASS** — required evidence is attached, reproducible, and tied to a commit/build and test environment.
- **FAIL** — a repeatable acceptance criterion was not met.
- **BLOCKED** — the test could not be run because a dependency, device, credential, or environment was unavailable.
- **NOT RUN** — no test was executed.
- **NOT APPLICABLE** — the reason and approving owner are documented.

Do not record PASS without the evidence location, timestamp, commit SHA/build identifier, environment, and responsible tester. Never attach camera credentials, tokens, private keys, or unredacted sensitive footage to a public issue or repository.

## Gate register

| Gate | Minimum evidence required | Pass condition |
|---|---|---|
| Build and regression suite | GitHub Actions run URL, commit SHA, completed job summary | Required workflow succeeds for the exact candidate commit; test-suite coverage guard passes |
| Browser acceptance | Browser/version, OS/viewport, screenshots or sanitized trace, route-by-route results, console/network errors | Primary navigation, keyboard use, responsive layout, session handling, error states and reload behavior work without uncaught errors |
| Tenant/site isolation | Sanitized request/response matrix for no token, expired token, wrong organization, wrong site, insufficient permissions, revoked connector, spoofed scope | Each unauthorized case is denied; authorized same-scope cases succeed; no cross-tenant data leaks in bodies, counts, errors or logs |
| Camera/NVR integration | Device make/model and firmware, approved protocol/profile, adapter version, connection timestamp, stream probe/log, sanitized sample frame or local evidence reference | Actual stream is decoded and timestamped; disconnect/reconnect, invalid credentials and unavailable recorder produce explicit safe states; no secrets leak to browser or logs |
| Counting accuracy | Dataset/clip IDs and hashes, annotation version, model/version, configuration, ground-truth crossings, predicted crossings, confusion counts and metric report | Customer-approved precision/recall and count-error thresholds are met on a held-out, representative benchmark; duplicate, missed, wrong-direction and track-switch cases are reported separately |
| Persistence and restore | Backup ID/hash, database integrity output, restore-drill logs, recovered record counts, duration, source-backup hash before/after | Restore is performed into an isolated target, integrity checks pass, expected records are present, source backup is unchanged, and recovery-time/data-loss objectives are met |
| Learning pipeline | Source authorization, content hash, review/annotation record, dataset version, split manifest, training run ID, model artifact digest, independent evaluation report, approver and rollback reference | Unreviewed inputs cannot silently become trusted labels; evaluation is reproducible; promotion is approval-gated; rollback is demonstrable |

## Counting metrics

Use a stable, reviewed ground-truth annotation and report at least:

- True-positive, false-positive and false-negative crossings.
- Precision and recall.
- Absolute count error per clip/camera/direction and aggregate mean absolute error.
- Duplicate crossing rate, missed crossing rate, wrong-direction rate, and track-ID switch cases.
- Frame rate, dropped frames, inference latency, stream reconnect behavior, lighting/occlusion conditions.

Agree thresholds with the customer before running acceptance. Do not tune on the held-out evaluation set. Report the full denominator and any excluded clips; do not report only a favorable aggregate percentage.

## Camera and recording trust boundaries

- An inventory record does not prove that a camera is online.
- A decoded stream proves stream availability at the test time, not recording continuity.
- Signed connector telemetry proves that an enrolled key signed a report; it does not independently prove footage exists or can be retrieved.
- Recording assurance stays **reported, not independently verified** until recorder evidence has been independently checked.
- Use authorized, read-only access and customer-approved test devices. Never guess credentials or scan networks without explicit authorization.

## Required acceptance record

Copy one record per gate into the deployment ticket or controlled customer acceptance report:

```text
Gate:
Status: NOT RUN
Repository commit / build:
Environment / device:
Tester / approver:
Started / completed (UTC):
Procedure or test command:
Evidence location (restricted if sensitive):
Expected result:
Actual result:
Defects / follow-up:
```

## Current implementation boundary

The current README and source describe the CCTV-first UI, API foundations, connector telemetry, SQLite backup/restore checks, and learning-source intake. These are not interchangeable with deployment acceptance. A real network-camera/NVR adapter and end-to-end camera pilot, authenticated stream/session lifecycle, measured inference/counting performance, deployment-specific identity/secret lifecycle, and governed training/evaluation/promotion still require their own evidence before production sign-off.

This document is an evidence template; it does not assert that any deployment-specific gate has passed.
