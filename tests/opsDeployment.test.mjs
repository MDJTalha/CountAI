import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const read = path => readFile(new URL('../' + path, import.meta.url), 'utf8');

test('backup exporter fails closed and validates source, destination, size and digest', async () => {
  const script = await read('ops/export-backup.sh');
  assert.match(script, /set -Eeuo pipefail/);
  assert.match(script, /docker compose exec -T countai node scripts\/backup-sqlite\.mjs/);
  assert.match(script, /integrity.*ok/);
  assert.match(script, /countai-\*\.sqlite/);
  assert.match(script, /actual_bytes.*bytes/);
  assert.match(script, /sha256sum/);
  assert.match(script, /refusing to overwrite/);
  assert.match(script, /mountpoint -q/);
  assert.doesNotMatch(script, /curl .*\|.*sh/i);
  assert.doesNotThrow(() => execFileSync('bash', ['-n', new URL('../ops/export-backup.sh', import.meta.url).pathname]));
});

test('systemd units schedule both backup export and retention maintenance', async () => {
  const backupService = await read('ops/systemd/countai-backup.service');
  const backupTimer = await read('ops/systemd/countai-backup.timer');
  const retentionService = await read('ops/systemd/countai-retention.service');
  const retentionTimer = await read('ops/systemd/countai-retention.timer');
  assert.match(backupService, /ops\/export-backup\.sh/);
  assert.match(backupService, /UMask=0077/);
  assert.match(backupTimer, /OnCalendar=/);
  assert.match(retentionService, /scripts\/expire-learning-sources\.mjs/);
  assert.match(retentionTimer, /OnCalendar=/);
});

test('operations guide explicitly distinguishes SQLite backup from complete media recovery', async () => {
  const guide = await read('docs/OPERATIONS_BACKUP.md');
  assert.match(guide, /does not encrypt the backup/);
  assert.match(guide, /Learning media is stored separately/);
  assert.match(guide, /isolated target/);
  assert.match(guide, /RTO\/RPO/);
});
