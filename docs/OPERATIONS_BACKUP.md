# CountAI backup export and scheduled maintenance

## What this protects

The application creates a consistent SQLite snapshot with `VACUUM INTO` and verifies SQLite integrity. The export helper copies that snapshot from the running container's backup volume to a separately mounted destination, checks byte size, sets restrictive file permissions and writes a SHA-256 digest in its success record.

A hash detects later change; it does not encrypt the backup, authenticate a remote destination, or prove a successful restore. The destination must be a controlled, encrypted (at rest and in transit as applicable), separately managed backup filesystem or mount. Prefer a different host/account and a retention policy with protected or immutable copies. Do not use a directory on the same root filesystem and call it off-host.

The current SQLite backup covers database metadata. Learning media is stored separately under `COUNTAI_LEARNING_MEDIA_DIR`; a complete recovery plan must protect and restore media alongside the database using a coordinated snapshot procedure. Do not claim complete recovery until that has been tested.

## Configure the destination

1. Configure an encrypted external/network backup filesystem using your organization's approved mount procedure.
2. Create a restricted destination directory, for example `/mnt/secure-backups/countai`, owned by the deployment operator with mode `0700`.
3. Ensure the mount is configured to fail closed and is available before the scheduled job runs. The helper checks that destinations under `/mnt` or `/media` are mount points.
4. Install the repository under `/opt/countai` or edit the supplied systemd unit paths to match your host. Run commands from the directory containing `compose.yaml`.
5. Install host dependencies `docker`, `docker compose`, `jq`, `sha256sum` and `mountpoint`.

## Run an export manually

With the CountAI Compose service running and the destination mounted:

```sh
sudo ops/export-backup.sh /mnt/secure-backups/countai
```

A successful command prints a JSON record containing the backup filename, byte count, SQLite integrity result, SHA-256 digest and UTC export time. Exit status other than zero means the export must be treated as failed. Monitor the result rather than merely checking that a file exists.

Verify a copied backup on the destination:

```sh
cd /mnt/secure-backups/countai
sha256sum countai-<timestamp>-<uuid>.sqlite
```

Compare the digest with the success record stored in the restricted job log. Retain the digest and backup manifest with the same access controls as the backup. Test restore into an isolated database using the repository's restore verification tooling; do not overwrite the live database during a drill.

## Install scheduled jobs

The supplied systemd unit files assume the repository is at `/opt/countai` and the secure backup mount is `/mnt/secure-backups/countai`. Review paths, permissions, retention, and the destination mount before enabling them.

```sh
sudo install -m 0644 ops/systemd/countai-backup.service /etc/systemd/system/
sudo install -m 0644 ops/systemd/countai-backup.timer /etc/systemd/system/
sudo install -m 0644 ops/systemd/countai-retention.service /etc/systemd/system/
sudo install -m 0644 ops/systemd/countai-retention.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now countai-backup.timer countai-retention.timer
systemctl list-timers 'countai-*'
```

Inspect outcomes and errors:

```sh
sudo systemctl start countai-backup.service
sudo systemctl status countai-backup.service
sudo journalctl -u countai-backup.service --since today
sudo journalctl -u countai-retention.service --since today
```

The backup timer runs daily at 02:15 UTC by the host's systemd timezone, with a randomized delay. The retention timer runs daily at 03:10. Confirm the host timezone and adjust the timer if necessary. The retention job uses `COUNTAI_LEARNING_SOURCE_RETENTION_DAYS` from the running container environment; a value of zero disables expiry.

## Recovery acceptance checklist

- [ ] Destination is a separate managed mount and its encryption/access policy is verified.
- [ ] Scheduled job has a monitored last-success time and alerts on failure, missing/stale output, low disk space and unmounted destination.
- [ ] Backup manifest and SHA-256 digest are stored in restricted logs.
- [ ] SQLite backup integrity check succeeds.
- [ ] Learning media is included in the approved coordinated backup plan.
- [ ] Restore is performed into an isolated target; expected tables and record counts are compared.
- [ ] Source backup bytes/hash are unchanged by the restore drill.
- [ ] Recovery time and recovered data loss are measured against approved RTO/RPO.
- [ ] An operator/approver records evidence in `ACCEPTANCE_EVIDENCE_MATRIX.md`.

This procedure is a repository-provided operational aid. It does not assert that a production host, external mount, encryption policy, scheduler, alerts, or restore drill has already been configured or tested.
