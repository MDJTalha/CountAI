import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createConsistentSqliteBackup } from '../server/spais/sqliteBackup.mjs';

test('SQLite backup creates a consistent, integrity-checked, private snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'countai-sqlite-backup-'));
  const sourcePath = join(dir, 'events.sqlite');
  const backupDirectory = join(dir, 'backups');
  const source = new DatabaseSync(sourcePath);
  let backup;
  source.exec('PRAGMA journal_mode=WAL; CREATE TABLE audit_events (id INTEGER PRIMARY KEY, action TEXT NOT NULL);');
  source.prepare('INSERT INTO audit_events (action) VALUES (?)').run('test.event');

  try {
    const result = await createConsistentSqliteBackup({
      databasePath: sourcePath,
      backupDirectory,
      now: new Date('2026-10-24T12:00:00.000Z')
    });
    assert.equal(result.integrity, 'ok');
    assert.ok(result.bytes > 0);
    backup = new DatabaseSync(result.backupPath);
    assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(backup.prepare('SELECT action FROM audit_events').get().action, 'test.event');
    backup.close();
    const info = await stat(result.backupPath);
    if (process.platform !== 'win32') {
      assert.ok((info.mode & 0o077) === 0, 'backup file must not be accessible to group/other users');
    }
  } finally {
    try { backup?.close(); } catch {}
    source.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('SQLite backup refuses missing source or missing destination configuration', async () => {
  await assert.rejects(
    () => createConsistentSqliteBackup({ databasePath: ':memory:', backupDirectory: '/tmp/countai-backups' }),
    /sqlite_backup_source_required/
  );
  await assert.rejects(
    () => createConsistentSqliteBackup({ databasePath: '/no/such/countai.sqlite', backupDirectory: '/tmp/countai-backups' }),
    /sqlite_backup_source_not_found/
  );
});
