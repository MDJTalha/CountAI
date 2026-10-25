import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { evaluateCrossingEvents } from '../src/engine/countingBenchmark.mjs';

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: node scripts/evaluate-counting-benchmark.mjs <benchmark.json>');
  console.error('Input schema: { "groundTruth": [...], "predictions": [...], "toleranceMs": 1000 }');
  process.exitCode = 2;
} else {
  try {
    const input = JSON.parse(await readFile(resolve(inputPath), 'utf8'));
    const report = evaluateCrossingEvents(input.groundTruth, input.predictions, {
      toleranceMs: input.toleranceMs ?? 1000
    });
    process.stdout.write(JSON.stringify({
      reportType: 'countai-crossing-benchmark-v1',
      generatedAt: new Date().toISOString(),
      ...report
    }, null, 2) + '\n');
  } catch (error) {
    console.error('Counting benchmark failed:', error?.message || 'invalid_input');
    process.exitCode = 1;
  }
}
