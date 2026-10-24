# SPAIS Customer-Controlled Recorder Pilot Checklist

## Purpose and acceptance boundary

Use this checklist to validate the connector against one customer-authorized recorder and camera in a customer-controlled network. This is a pilot acceptance record, not a claim that CI proves recording or production readiness.

The connector must make outbound connections only to explicitly configured endpoints. It must not require inbound access from the public internet, broad network discovery, firewall changes outside the agreed allowlist, or transfer of video/images to the SPAIS service. Recording assurance is based on connector-signed metadata and must remain labelled `reported_not_independently_verified`.

## 1. Authorization and scope

- [ ] Customer system owner and security/network approver authorize the test in writing.
- [ ] Record organization, site, connector, recorder, and camera IDs; verify each belongs to the intended tenant/site.
- [ ] Agree recorder host/port, protocol, credentials provisioning method, outbound destination, test window, and rollback contact.
- [ ] Use a dedicated least-privilege recorder account, preferably read-only and limited to health/recording metadata.
- [ ] Confirm no camera streams, snapshots, frames, recorder passwords, tokens, or private keys are sent as telemetry.
- [ ] Confirm the customer can disable connector egress and stop the service without vendor access.

**Stop condition:** Do not proceed if recorder access requires broader privileges than approved, the endpoint cannot be safely pinned/configured, or tenant/site/camera ownership is ambiguous.

## 2. Installation and network boundary

- [ ] Install the connector on a customer-managed host or approved edge VM.
- [ ] Generate the connector key locally; verify the private key is not exported and file permissions are restrictive for the host OS.
- [ ] Configure only approved recorder and SPAIS API endpoints.
- [ ] Verify HTTPS is enforced for non-local endpoints and credentials are not embedded in URLs.
- [ ] Verify inbound internet firewall access is not required.
- [ ] Record outbound DNS names/IPs and ports observed during testing.
- [ ] Confirm proxy, DNS, TLS inspection, and certificate policies with the customer.
- [ ] Verify logs and diagnostics contain no secrets or raw video/image data.

Evidence: approved network diagram, connector version/hash, redacted configuration, and firewall/proxy observations.

## 3. Enrollment and authorization boundaries

- [ ] Enroll the connector identity using the approved customer-controlled procedure.
- [ ] Submit a signed heartbeat and confirm acceptance.
- [ ] Submit a report for a camera registered to the same organization/site; confirm acceptance.
- [ ] Submit a report for an unregistered camera; confirm rejection.
- [ ] In an authorized test environment, attempt cross-site and cross-organization references; confirm rejection without leaking resource details.
- [ ] Verify stale timestamps, replayed nonces, invalid signatures, and delivery-ID reuse with a different payload are rejected.
- [ ] Confirm retrying the same delivery ID and payload returns the original receipt rather than creating a duplicate.

Evidence: redacted status codes, receipt IDs, and audit records. Never retain private keys or credentials in the evidence pack.

## 4. Offline store-and-forward and recovery

- [ ] Block only the connector's approved outbound API route; leave the recorder and customer network otherwise unchanged.
- [ ] Generate approved metadata events while offline and confirm they queue locally.
- [ ] Verify diagnostics show queue count/size/oldest age only, not event payloads.
- [ ] Confirm queue limits fail closed rather than silently deleting queued events or growing without bound.
- [ ] Restore the approved route and confirm queued events drain.
- [ ] Confirm delivery IDs remain stable across retries while each retry uses a fresh signed timestamp/nonce.
- [ ] Simulate a lost response after server acceptance; confirm retry is idempotent.
- [ ] Test an authentication/schema failure, document whether it blocks later entries, correct the cause, and verify recovery.
- [ ] Restart the connector while events are queued and verify documented persistence behavior.
- [ ] Verify queue files are restricted to the service account and are not symlinks or unexpected file types.

Record event counts before outage, queued, accepted, rejected, and remaining after recovery. Reconcile these counts and explain every difference before passing.

## 5. Recording assurance interpretation

- [ ] Compare connector-reported expected/recorded seconds with the recorder's own authorized status/export for the same window.
- [ ] Test a window with a known gap and verify it is not reported as complete.
- [ ] Test overlapping/partial windows, missing reports, and report-limit truncation; confirm each remains incomplete or inconclusive.
- [ ] Confirm future windows outside allowed tolerance and windows longer than seven days are rejected.
- [ ] Confirm stale reports are marked not fresh.
- [ ] Confirm UI/report wording says **connector-reported coverage**, not independently verified recording.
- [ ] Do not claim a signed digest proves the underlying recording exists or is retrievable; independently inspect recorder evidence where customer policy permits.

## 6. Handover and rollback

- [ ] Agree alert ownership for connector offline state, queue age/capacity, rejected telemetry, and stale coverage reports.
- [ ] Agree retention/deletion rules for local queue files, connector logs, and server-side metadata.
- [ ] Document restart/upgrade, key rotation/revocation, and customer disable/removal procedures.
- [ ] Confirm rollback: stop service, revoke connector identity, remove approved firewall rule, and preserve only customer-approved diagnostic evidence.
- [ ] Customer owner signs off on scope, observed results, known limitations, and unresolved issues.

## Pilot result

| Check | Result |
| --- | --- |
| Customer authorization | Pending |
| Recorder/API compatibility | Pending |
| Network boundary accepted | Pending |
| Enrollment and scope checks | Pending |
| Offline recovery and idempotency | Pending |
| Recorder-side comparison | Pending |
| Security/customer sign-off | Pending |

**Overall status:** Not yet validated against a real customer recorder. Complete this checklist with evidence before describing the connector or recording assurance as customer-pilot validated.
