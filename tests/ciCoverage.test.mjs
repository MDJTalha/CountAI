import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

test('every regression suite in npm test is also run by required GitHub Actions CI', () => {
  const testCommand = packageJson.scripts.test;
  assert.equal(typeof testCommand, 'string', 'package.json must define npm test');

  const localSuites = [...testCommand.matchAll(/npm run (test:[a-z0-9:-]+)/g)].map(match => match[1]);
  assert.ok(localSuites.length > 0, 'npm test must enumerate regression suites');

  const loop = workflow.match(/for script in ([\\s\\S]*?); do/);
  assert.ok(loop, 'CI workflow must declare the required regression suite loop');
  const ciSuites = new Set(loop[1].match(/test:[a-z0-9:-]+/g) ?? []);

  const missingFromCi = [...new Set(localSuites)].filter(name => !ciSuites.has(name));
  assert.deepEqual(missingFromCi, [], 'regression suites run locally must also run in CI');

  const missingFromPackage = [...ciSuites].filter(name => typeof packageJson.scripts[name] !== 'string');
  assert.deepEqual(missingFromPackage, [], 'CI must not reference undefined package scripts');
});
