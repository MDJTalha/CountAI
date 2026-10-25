#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Usage: ops/export-backup.sh /mnt/secure-backups/countai
# The destination must be a separately managed, access-restricted backup mount.
# This script copies a consistent, integrity-checked snapshot; it does not encrypt
# the destination or prove that the mount is physically off-host.
destination="${1:-}"
if [[ -z "$destination" || "$destination" != /* ]]; then
  echo "Usage: $0 /absolute/path/to/secure-backup-mount" >&2
  exit 2
fi
if ! command -v docker >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1 || ! command -v sha256sum >/dev/null 2>&1; then
  echo "Required host commands: docker, jq, sha256sum" >&2
  exit 2
fi
if ! docker compose ps --status running --services | grep -qx 'countai'; then
  echo "CountAI service must be running before a backup can be exported." >&2
  exit 1
fi
if [[ ! -d "$destination" ]]; then
  echo "Backup destination must already exist; refusing to create a directory on an unexpected local filesystem." >&2
  exit 1
fi
if [[ ! -w "$destination" ]]; then
  echo "Backup destination is not writable." >&2
  exit 1
fi
# Fail closed if an expected removable/network mount is not mounted.
if command -v mountpoint >/dev/null 2>&1 && [[ "$destination" == /mnt/* || "$destination" == /media/* ]]; then
  if ! mountpoint -q "$destination"; then
    echo "Expected backup mount is not mounted: $destination" >&2
    exit 1
  fi
fi

report="$(docker compose exec -T countai node scripts/backup-sqlite.mjs)"
source_path="$(printf '%s' "$report" | jq -er '.backupPath | select(type == "string")')"
integrity="$(printf '%s' "$report" | jq -er '.integrity | select(. == "ok")')"
bytes="$(printf '%s' "$report" | jq -er '.bytes | select(type == "number" and . > 0)')"
[[ "$source_path" == /var/backups/countai/countai-*.sqlite ]] || {
  echo "Backup tool returned an unexpected path; refusing to copy." >&2
  exit 1
}
name="${source_path##*/}"
temporary="$destination/.${name}.partial"
final="$destination/$name"
if [[ -e "$final" || -e "$temporary" ]]; then
  echo "Destination file already exists; refusing to overwrite." >&2
  exit 1
fi
cleanup() { rm -f -- "$temporary"; }
trap cleanup EXIT

docker cp "countai:$source_path" "$temporary"
chmod 600 "$temporary"
actual_bytes="$(stat -c '%s' "$temporary")"
[[ "$actual_bytes" == "$bytes" ]] || {
  echo "Export size mismatch; refusing to publish backup." >&2
  exit 1
}
hash="$(sha256sum "$temporary" | awk '{print $1}')"
[[ "$hash" =~ ^[a-f0-9]{64}$ ]] || {
  echo "Could not calculate a valid SHA-256 digest." >&2
  exit 1
}
mv -- "$temporary" "$final"
trap - EXIT
printf '{"task":"sqlite-backup-export","file":"%s","bytes":%s,"integrity":"%s","sha256":"%s","exportedAt":"%s"}\n' \
  "$name" "$actual_bytes" "$integrity" "$hash" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
