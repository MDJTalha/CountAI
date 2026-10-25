import { verifySqliteBackupRestore } from '../server/spais/sqliteRestoreDrill.mjs';

try {
  const result = await verifySqliteBackupRestore();
  process.stdout.write(JSON.stringify({ task: 'sqlite-restore-drill', ...result }) + String.fromCharCode(10));
} catch (error) {
  console.error('SQLite restore drill failed:', error?.code || error?.name || 'unknown_error');
  process.exitCode = 1;
}
