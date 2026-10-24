import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rm, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const fail = code => Object.assign(new Error(code), { code });

/**
 * Create a consistent SQLite snapshot with VACUUM INTO instead of copying an
 * active database/WAL file. The output is private by default and verified
 * with SQLite's integrity_check before it is reported as successful.
 */
export async function createConsistentSqliteBackup({
  databasePath = process.env.SPAIS_EVENTS_DB_PATH,
  backupDirectory = process.env.COUNTAI_BACKUP_DIR,
  now = new Date()
} = {}) {
  if (typeof databasePath !== 'string' || !databasePath.trim() || databasePath === ':memory:') {
    throw fail('sqlite_backup_source_required');
  }
  if (typeof backupDirectory !== 'string' || !backupDirectory.trim()) {
    throw fail('sqlite_backup_directory_required');
  }
  const sourcePath = resolve(databasePath);
  let sourceInfo;
  try { sourceInfo = await stat(sourcePath); }
  catch { throw fail('sqlite_backup_source_not_found'); }
  if (!sourceInfo.isFile()) throw fail('sqlite_backup_source_not_file');

  const outputDirectory = resolve(backupDirectory);
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const timestamp = (now instanceof Date && Number.isFinite(now.getTime()) ? now : new Date())
    .toISOString().replace(/[:.]/g, '-');
  const outputPath = join(outputDirectory, `countai-${timestamp}-${randomUUID()}.sqlite`);
  if (resolve(outputPath) === sourcePath || basename(outputPath) === basename(sourcePath) && outputDirectory === resolve(sourcePath, '..')) {
    throw fail('sqlite_backup_source_equals_destination');
  }

  let sourceDb;
  let backupDb;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    sourceDb = new DatabaseSync(sourcePath);
    // VACUUM INTO writes a transactionally consistent snapshot and includes
    // committed WAL content; never copy an active SQLite database file directly.
    const escapedPath = outputPath.replace(/'/g, "''");
    sourceDb.exec(`VACUUM INTO '${escapedPath}'`);
    await chmod(outputPath, 0o600);
    backupDb = new DatabaseSync(outputPath);
    const integrity = backupDb.prepare('PRAGMA integrity_check').get();
    if (!integrity || Object.values(integrity)[0] !== 'ok') {
      throw fail('sqlite_backup_integrity_check_failed');
    }
    const outputInfo = await stat(outputPath);
    if (!outputInfo.isFile() || outputInfo.size < 1) throw fail('sqlite_backup_output_invalid');
    return { backupPath: outputPath, bytes: outputInfo.size, integrity: 'ok' };
  } catch (error) {
    try { await rm(outputPath, { force: true }); } catch {}
    if (error?.code && String(error.code).startsWith('sqlite_backup_')) throw error;
    throw Object.assign(fail('sqlite_backup_failed'), { cause: error });
  } finally {
    try { backupDb?.close(); } catch {}
    try { sourceDb?.close(); } catch {}
  }
}
