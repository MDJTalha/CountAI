import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { verifySqliteBackupRestore } from '../server/spais/sqliteRestoreDrill.mjs';

test('restore drill verifies a temporary read-only copy and leaves the backup unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'countai-restore-test-'));
  const backupPath = join(directory, 'known-good.sqlite');
  const database = new DatabaseSync(backupPath);
  database.exec('CREATE TABLE audit_events (id INTEGER PRIMARY KEY, action TEXT NOT NULL);');
  database.prepare('INSERT INTO audit_events (action) VALUES (?)').run('restore.test');
  database.close();
  const before = await readFile(backupPath);

  try {
    const result = await verifySqliteBackupRestore({ backupPath });
    assert.equal(result.verified, true);
    assert.equal(result.integrity, 'ok');
    assert.equal(result.quickCheck, 'ok');
    assert.equal(result.tableCount, 1);
    assert.deepEqual(result.tables, ['audit_events']);
    assert.deepEqual(await readFile(backupPath), before, 'source backup must not be modified');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('restore drill rejects missing and corrupt backups without changing source data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'countai-restore-invalid-'));
  const corruptPath = join(directory, 'corrupt.sqlite');
  await writeFile(corruptPath, 'not a SQLite database');

  try {
    await assert.rejects(
      () => verifySqliteBackupRestore({ backupPath: join(directory, 'missing.sqlite') }),
      /sqlite_restore_backup_not_found/
    );
    await assert.rejects(
      () => verifySqliteBackupRestore({ backupPath: corruptPath }),
      /sqlite_restore_verification_failed/
    );
    assert.equal((await readFile(corruptPath, 'utf8')), 'not a SQLite database');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
