import { createSqliteLearningSourceStore } from '../server/spais/learningSources.mjs';

const retentionDays = Number(process.env.COUNTAI_LEARNING_SOURCE_RETENTION_DAYS || 0);
if (!process.env.SPAIS_EVENTS_DB_PATH) {
  console.error('SPAIS_EVENTS_DB_PATH is required; refusing to run retention maintenance without a persistent database.');
  process.exitCode = 2;
} else if (!Number.isInteger(retentionDays) || retentionDays < 0 || retentionDays > 3650) {
  console.error('COUNTAI_LEARNING_SOURCE_RETENTION_DAYS must be an integer from 0 to 3650; 0 disables expiry.');
  process.exitCode = 2;
} else {
  try {
    const store = createSqliteLearningSourceStore();
    try {
      const result = await store.purgeExpired({ retentionDays });
      process.stdout.write(JSON.stringify({ task: 'learning-source-retention', ...result }) + String.fromCharCode(10));
      if (result.failed > 0 || result.mediaCleanupPending > 0) process.exitCode = 1;
    } finally {
      await store.close();
    }
  } catch (error) {
    console.error('Learning-source retention maintenance failed:', error?.code || error?.name || 'unknown_error');
    process.exitCode = 1;
  }
}
