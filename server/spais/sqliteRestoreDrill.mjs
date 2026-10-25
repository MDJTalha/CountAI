import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const fail = code => Object.assign(new Error(code), { code });

/**
 * Validate a completed SQLite backup by copying it to an isolated temporary
 * path and opening that copy read-only. Never writes to the configured
 * production database or modifies the source backup.
 */
export async function verifySqliteBackupRestore({ backupPath = process.env.COUNTAI_BACKUP_VERIFY_PATH } = {}) {
  if (typeof backupPath !== 'string' || !backupPath.trim()) {
    throw fail('sqlite_restore_backup_required');
  }

  const sourcePath = resolve(backupPath);
  let sourceInfo;
  try { sourceInfo = await stat(sourcePath); }
  catch { throw fail('sqlite_restore_backup_not_found'); }
  if (!sourceInfo.isFile() || sourceInfo.size < 1) {
    throw fail('sqlite_restore_backup_invalid');
  }

  const workDirectory = await mkdtemp(join(tmpdir(), 'countai-restore-drill-'));
  const restoredPath = join(workDirectory, basename(sourcePath));
  let database;
  try {
    await copyFile(sourcePath, restoredPath);
    const { DatabaseSync } = await import('node:sqlite');
    database = new DatabaseSync(restoredPath, { readOnly: true });
    const integrityRow = database.prepare('PRAGMA integrity_check').get();
    const integrity = integrityRow && Object.values(integrityRow)[0];
    if (integrity !== 'ok') throw fail('sqlite_restore_integrity_check_failed');

    const quickCheckRow = database.prepare('PRAGMA quick_check').get();
    const quickCheck = quickCheckRow && Object.values(quickCheckRow)[0];
    if (quickCheck !== 'ok') throw fail('sqlite_restore_quick_check_failed');

    const tables = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all().map(row => row.name);

    return {
      verified: true,
      integrity: 'ok',
      quickCheck: 'ok',
      bytes: sourceInfo.size,
      tableCount: tables.length,
      tables
    };
  } catch (error) {
    if (error?.code && String(error.code).startsWith('sqlite_restore_')) throw error;
    throw Object.assign(fail('sqlite_restore_verification_failed'), { cause: error });
  } finally {
    try { database?.close(); } catch {}
    await rm(workDirectory, { recursive: true, force: true });
  }
}
