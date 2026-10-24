# SPAIS customer-controlled edge connector (pilot adapter)

This Node.js agent runs inside the customer environment. It opens no inbound listener and does not scan the network. It contacts only the explicitly configured SPAIS API and, optionally, one explicitly configured recorder-status endpoint.

## Requirements

- Node.js 22+.
- A connector record already created at the correct SPAIS organization/site.
- An operator-authorized enrollment challenge for the connector public RSA JWK.
- A customer-approved, read-only recorder/NVR status endpoint if camera/recording reports are required.

## 1. Generate the connector key locally

Set `SPAIS_CONNECTOR_PRIVATE_KEY_PATH` to a protected path on the customer-controlled host, then run:

```bash
node connector/agent.mjs generate-key
```

The private key is created locally as a PKCS#8 RSA key (2048 bits) with restrictive file permissions where supported. The command prints the public JWK for an authorized operator to register. Never upload or copy the private key to SPAIS.

## 2. Complete enrollment

After an authorized operator registers the public JWK and creates a challenge, supply these environment variables and run:

```bash
node connector/agent.mjs complete-enrollment
```

Required enrollment values: `SPAIS_SERVER_URL`, `SPAIS_ORGANIZATION_ID`, `SPAIS_SITE_ID`, `SPAIS_CONNECTOR_ID`, `SPAIS_CONNECTOR_PRIVATE_KEY_PATH`, `SPAIS_ENROLLMENT_ID`, and `SPAIS_ENROLLMENT_CHALLENGE`.

The agent signs the one-time challenge with its local private key. The challenge is short-lived and cannot be replayed after completion. Rotate or revoke keys through the authorized SPAIS operator workflow.

## 3. Run the agent

Required environment:
- `SPAIS_SERVER_URL` — HTTPS SPAIS API URL.
- `SPAIS_ORGANIZATION_ID`, `SPAIS_SITE_ID`, and `SPAIS_CONNECTOR_ID`.
- `SPAIS_CONNECTOR_PRIVATE_KEY_PATH`.
- `SPAIS_CONNECTOR_QUEUE_PATH` — optional path for the durable metadata-only delivery queue. Defaults to `<private-key-path>.queue.json`; protect it with the same host-level access controls as the private key.

Optional environment:
- `SPAIS_CONNECTOR_POLL_SECONDS` — 15–300 seconds (default 30).
- `SPAIS_RECORDER_STATUS_URL` — one preconfigured read-only JSON endpoint; no host discovery or scanning occurs.
- `SPAIS_RECORDER_BEARER_TOKEN` — optional secret supplied through the environment/secret manager, never in the URL.
- `SPAIS_RECORDER_ALLOW_HTTP=true` — explicit opt-in for a customer-approved local recorder endpoint that lacks HTTPS.
- `SPAIS_ALLOW_INSECURE_SERVER_HTTP=true` — development/lab-only override; production should use HTTPS.

Run once for a smoke test:
```bash
node connector/agent.mjs run-once
```

Run continuously with a bounded polling interval and SIGINT/SIGTERM shutdown:
```bash
node connector/agent.mjs run
```

The agent sends signed metadata telemetry only. It never uploads raw video frames, snapshots, or images. It logs event counts and machine-readable error codes, not credentials or report payloads.

## Recorder status adapter contract

The configured endpoint must return a JSON object with `cameraHealth` and `recordingCoverage` arrays. A camera-health item uses `cameraId`, `status` (`online`, `offline`, or `unknown`), and optional `observedAt`. A recording-coverage item uses `cameraId`, `windowStart`, `windowEnd`, `recordedSeconds`, `expectedSeconds`, and a SHA-256 `evidenceDigest` (64 hexadecimal characters).

Each poll is limited to 32 camera-health reports and 32 recording-coverage reports, with a 64 KiB response limit. The endpoint must be configured explicitly by the customer. Do not use camera RTSP stream URLs as status endpoints.

**Important:** a connector-signed recording-coverage report is an attested connector report, not independently verified proof that the NVR actually recorded footage. Vendor-specific recorder adapters, trustworthy evidence-source validation, time synchronization, operational monitoring, rate limiting, and a controlled customer lab test are required before production recording assurance.

## Network and security boundary

- The agent has no inbound listener and performs no network discovery, port scanning, or credential guessing.
- Configure outbound firewall access only to the approved SPAIS API and the specific customer-approved recorder status endpoint.
- Protect the private key with OS-level access controls and backups; do not commit it to source control.
- Use a secret manager or service environment for recorder credentials; never put secrets in endpoint query strings.
- Signed metadata events are written to a local atomic queue before delivery when queueing is enabled (the continuous CLI enables it by default). The queue is capped at 1,000 entries and 2 MiB, rejects symlink/non-regular queue files, and attempts restrictive file permissions. It contains event metadata only, never video, images, credentials, or private keys.
- Delivery uses a stable `deliveryId` with a fresh signed timestamp and nonce on each attempt. The server stores a scoped idempotency receipt so an accepted event whose response was lost does not create a second telemetry record on retry.
- The queue is at-least-once transport with server-side deduplication. Authentication/schema errors remain queued and can block newer items until configuration is corrected; queue-capacity exhaustion fails closed rather than silently dropping older reports.
- A crash after the server accepts an event but before the queue file is updated is handled by the stable delivery ID. This is still pilot-grade local persistence: disk failure, host loss, backups, monitoring, and customer lab validation require operational procedures.
