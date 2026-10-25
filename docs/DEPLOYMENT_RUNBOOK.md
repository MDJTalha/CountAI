# CountAI production deployment runbook

## Scope and honest readiness boundary

This repository now provides a single-host Docker deployment path for the built CCTV-first web application and Node API, with persistent SQLite and backup volumes. It is a deployment package, not proof that a production service has been launched or accepted.

**Do not expose this service directly to the public internet.** Compose binds port 8787 to loopback. Put it behind a managed HTTPS reverse proxy or load balancer, enforce TLS there, and set `COUNTAI_ENABLE_HSTS=true` only after HTTPS is enforced. Keep the identity provider, database, backups and host administration under controlled access.

The deployment does not implement a network-camera/RTSP decoder or prove counting accuracy. The UI should continue to report no verified stream until an authorized adapter actually decodes one.

## Requirements

- A supported Linux host with Docker Engine and Docker Compose v2.
- A domain and HTTPS reverse proxy managed by the deployment operator.
- An OIDC provider exposing an HTTPS JWKS endpoint, with issuer/audience claims configured to match CountAI's authorization contract.
- A host-level backup/export destination outside the Compose volumes, with restricted access and retention.
- A reviewed retention policy, named operator, incident contact and rollback owner.

Do not deploy using the example identity-provider values. Replace every `example.com` value with your real, reachable provider settings. Keep `.env` out of Git and restrict it to the deployment account.

## First deployment

1. Check out the reviewed commit on the deployment host. Record its full Git SHA.
2. Copy the environment template: `cp .env.example .env`. Edit the issuer, audience, JWKS URL and retention policy. The HS256 alternative is not the default and requires an approved secret-management/rotation plan.
3. Restrict environment-file permissions: `chmod 600 .env`.
4. Validate configuration and build the image:
   ```sh
   docker compose build --pull
   docker compose run --rm --no-deps countai npm run check:production-config
   ```
   A valid configuration report checks required settings only. It does not prove identity-provider reachability or validate the claims emitted by that provider.
5. Start and inspect:
   ```sh
   docker compose up -d
   docker compose ps
   docker compose logs --tail=100 countai
   curl --fail http://127.0.0.1:8787/api/health
   curl --fail http://127.0.0.1:8787/api/v1/spais/contracts
   ```
6. Confirm the container health status is healthy. Test the HTTPS hostname through the reverse proxy; verify certificate validity, HTTP-to-HTTPS behavior, request size/timeouts and that the backend is not publicly reachable on port 8787.
7. Run the tenant/site authorization matrix with real, short-lived test identities: missing/expired token, wrong organization, wrong site, insufficient action, revoked connector and authorized same-scope request. Verify sensitive values never appear in responses or logs.
8. Capture the commit SHA, image ID, environment (without secrets), test time, tester and evidence links in the acceptance matrix.

## Upgrade and rollback

Before every upgrade, record the current image ID and commit SHA, run regression tests, and create a verified backup. Build the new image, then recreate the service:

```sh
docker compose build --pull
docker compose run --rm --no-deps countai npm run check:production-config
docker compose up -d --force-recreate
docker compose ps
docker compose logs --tail=100 countai
curl --fail http://127.0.0.1:8787/api/health
```

If health or smoke tests fail, stop traffic at the reverse proxy and redeploy the previously recorded image/commit. Do not assume an application rollback reverses database schema changes; inspect migration compatibility and restore only under the approved recovery procedure.

## Backup and restore

The backup command uses SQLite's consistent `VACUUM INTO` snapshot and checks database integrity. It expects the configured source database to exist and the backup directory to have restrictive permissions.

```sh
docker compose exec countai npm run maintenance:backup-sqlite
docker compose exec countai npm run maintenance:verify-sqlite-restore
``

The restore-drill command verifies the repository's automated drill, but operators must still test recovery for the deployed host. Export the created backup from the named backup volume to a separately managed, encrypted destination, verify its hash, restrict access and apply retention. A Docker volume on the same host is not an off-site backup.

For an actual recovery exercise, restore into an isolated target, run SQLite integrity checks, compare expected record counts and prove the source backup was not modified. Record recovery time and recovered data against agreed RTO/RPO. Do not overwrite the active database during a drill.

## Maintenance and operations

- Schedule `npm run maintenance:expire-learning-sources` using an approved host scheduler or maintenance job; source expiry is not automatic unless scheduled.
- Schedule and monitor backups; alert on non-zero exit, missing output, low disk space and stale last-success timestamp.
- Back up the SQLite database and learning media together under a consistent procedure; verify restoration of both metadata and authorized media.
- Monitor container health, process restarts, disk usage, 4xx/5xx rates, latency, auth-provider errors and backup age. Avoid logging bearer tokens, private keys, camera URLs or raw footage.
- The rate limiter is process-local and is not a shared multi-replica control. This Compose setup is single-host/single-instance. Do not horizontally scale SQLite files across hosts.
- Set retention, access and deletion policy before uploading any customer footage or learning data.

## Release acceptance gates

Use [the acceptance evidence matrix](ACCEPTANCE_EVIDENCE_MATRIX.md) and mark each gate PASS, FAIL, BLOCKED or NOT RUN. At minimum, deployment acceptance requires:

- [ ] Build and full regression CI passes for the deployed SHA.
- [ ] Browser acceptance on the target HTTPS origin.
- [ ] OIDC issuer/audience/JWKS verified against real test tokens.
- [ ] Tenant/site isolation matrix passes.
- [ ] Backup exported off-host and isolated restore drill passes.
- [ ] Retention job runs and is observable.
- [ ] Customer-approved camera/NVR stream is decoded and reconnect behavior is verified.
- [ ] Counting benchmark passes customer-approved thresholds on held-out annotated footage.
- [ ] Learning data, model evaluation and promotion controls are reviewed; no unapproved auto-promotion.
- [ ] Security and operational owners approve the release.

The final four environment/device-specific gates cannot be completed by GitHub CI alone. Do not mark them PASS without evidence from the target deployment and authorized camera/recorder.
