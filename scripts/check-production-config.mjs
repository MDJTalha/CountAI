import { validateProductionConfig } from '../server/productionConfig.mjs';

const report = validateProductionConfig(process.env);
process.stdout.write(JSON.stringify({ task: 'production-config-check', ...report }, null, 2) + String.fromCharCode(10));
if (!report.valid) process.exitCode = 1;
