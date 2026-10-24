# SPAIS Customer-Controlled Recorder Pilot Checklist

## Purpose and acceptance boundary

Use this checklist to validate the connector against one customer-authorized recorder and camera in a customer-controlled network. It is a pilot acceptance record, not a claim that CI proves recording or production readiness.

The connector must make outbound connections only to explicitly configured endpoints. It must not require inbound access from the public internet, broad network discovery, firewall changes outside the agreed allowlist, or transfer of video/images to the SPAIS service. The current recording assurance result is based on connector-signed metadata and must remain labelled `reported_not_independently_verified`.

## 1. Preflight authorization and scope

- [ ] Customer system owner and security/network approver have authorized the test in writing.
- [ ] Record organization, site, connector, recorder, and camera IDs; verify each is registered to the intended tenant/site.
- [ ] Agree the exact recorder host/port, protocol, credentials provisioning method, egress destination, test window, and rollback contact.
- [ ] Use a dedicated least-privilege recorder account, preferably read-only and limited to health/recording metadata.
- [ ] Confirm no camera streams, snapshots, frames, recorder passwords, tokens, or private keys are sent as telemetry.
- [ ] Confirm the customer's network owner can disable connector egress and stop the service without vendor access.

**Stop condition:** Do not continue if the recorder API requires broader privileges than approved, the endpoint cannot be pinned/configured safely, or tenant/site/camera ownership is ambiguous.

## 2. Installation and network boundary

- [ ] Install the connector on a customer-managed host or approved edge VM.
- [ ] Generate the connector key locally; verify the private key is not exported and file permissions are restrictive for the host OS.
- [ ] Configure only the approved recorder endpoint and SPAIS API endpoint.
- [ ] Verify HTTPS is enforced for non-local endpoints and endpoint credentials are not embedded in URLs.
- [ ] Verify inbound firewall access from the internet is not required.
- [ ] Record the exact outbound DNS names/IPs and ports observed during the test.
- [ ] Confirm proxy, DNS, TLS inspection, and certificate policy with the customer before testing.
- [ ] Verify logs and diagnostic output contain no secrets or raw video/image data.

Evidence to retain: approved network diagram, connector version/hash, configuration with secrets redacted, and firewall/proxy observations.

## 3. Enrollment and authorization boundaries

- [ ] Enroll the connector identity using the approved customer-controlled procedure.
- [ ] Submit a signed heartbeat from the registered connector and confirm it is accepted.
- [ ] Submit a report for a camera registered to the same organization and site; confirm acceptance.
- [ ] Submit a report for an unregistered camera; confirm rejection.
- [ ] Attempt a cross-site or cross-organization camera reference in an authorized test environment; confirm rejection without leaking resource details.
- [ ] Verify stale timestamps, replayed nonces, invalid signatures, and delivery-ID reuse with a different payload are rejected.
- [ ] Confirm retrying the same delivery ID and same payload returns the original receipt rather than creating a duplicate.

Evidence to retain: redacted request/result status codes, receipt IDs, and audit records. Never retain private keys or credentials in the evidence pack.

## 4. Offline store-and-forward and recovery

- [ ] Stop or block only the connector's approved outbound API route; leave the recorder and customer network otherwise unchanged.
- [ ] Generate approved metadata events while offline and confirm they queue locally.
- [ ] Verify queue diagnostics show count/size/oldest age only, not event payloads.
- [ ] Confirm the queue fails closed at configured limits rather than deleting queued events silently or growing without bound.
- [ ] Restore the approved route and confirm queued events drain.
- [ ] Confirm delivery IDs remain stable across retries while each retry uses a fresh signed timestamp/nonce.
- [ ] Simulate a lost response after server acceptance; confirm retry is idempotent.
- [ ] Test an authentication/schema failure and document whether it blocks later queued events; correct the cause and verify recovery.
- [ ] Restart the connector while events are queued and verify the documented persistence behavior.
- [ ] Verify queue files are readable only by the service account and are not symlinks or unexpected file types.

Record event counts before outage, queued, accepted, rejected, and remaining after recovery. Reconcile these counts; explain any difference before passing.

## 5. Recording assurance interpretation

- [ ] Compare connector-reported expected and recorded seconds with the recorder's own authorized status/export for the same window.
- [ ] Test a window with a known gap and verify it is not reported as complete.
- [ ] Test overlapping windows, partial windows, missing reports, and report-limit truncation; confirm each remains incomplete/inconclusive.
- [ ] Confirm future windows outside the allowed tolerance and windows longer than seven days are rejected.
- [ ] Confirm stale reports are marked not fresh.
- [ ] Confirm dashboard/report language says **connector-reported coverage**, not independently verified recording.
- [ ] Do not claim that a signed digest proves the underlying recording exists or is retrievable; independently inspect recorder evidence where customer policy permits.

## 6. Operational handover and rollback

- [ ] Agree alert ownership for connector offline state, queue age/capacity, rejected telemetry, and stale coverage reports.
- [ ] Agree retention and deletion rules for local queue files, connector logs, and server-side metadata.
- [ ] Document restart/upgrade procedure, key rotation/revocation, and how the customer disables or removes the connector.
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
