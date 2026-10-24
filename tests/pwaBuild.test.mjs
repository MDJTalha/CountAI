import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

const dist = new URL('../dist/', import.meta.url);
const assets = new URL('../dist/assets/', import.meta.url);

test('production build emits the CCTV-first app shell, manifest and service worker', async () => {
  const [html, worker, manifest] = await Promise.all([
    readFile(new URL('index.html', dist), 'utf8'),
    readFile(new URL('sw.js', dist), 'utf8'),
    readFile(new URL('manifest.webmanifest', dist), 'utf8')
  ]);

  assert.match(html, /<html|<!doctype html/i);
  assert.match(html, /CCTV-first|camera intelligence/i);
  assert.match(worker, /precacheAndRoute/);
  const parsedManifest = JSON.parse(manifest);
  assert.equal(parsedManifest.name, 'CountAI by AIVON');
  assert.equal(parsedManifest.start_url, '/');
  assert.equal(parsedManifest.scope, '/');
});

test('CCTV-first production bundle excludes the legacy browser photo detector', async () => {
  const names = await readdir(assets);
  assert.ok(
    !names.some(name => /^localDetector-.+\.js$/.test(name)),
    'legacy photo detector must not be shipped in the CCTV-first bundle'
  );
  const worker = await readFile(new URL('sw.js', dist), 'utf8');
  assert.doesNotMatch(worker, /countai-detector-assets|localDetector-[^"']+\.js/);
});
