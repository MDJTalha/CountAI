import { createConsistentSqliteBackup } from '../server/spais/sqliteBackup.mjs';

try {
  const result = await createConsistentSqliteBackup();
  process.stdout.write(JSON.stringify({ task: 'sqlite-backup', ...result }) + String.fromCharCode(10));
} catch (error) {
  console.error('SQLite backup failed:', error?.code || error?.name || 'unknown_error');
  process.exitCode = 1;
}
