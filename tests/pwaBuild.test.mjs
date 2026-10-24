import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const dist = new URL('../dist/', import.meta.url);
const assets = new URL('../dist/assets/', import.meta.url);

test('production build emits the app shell, manifest and service worker', async () => {
  const [html, worker, manifest] = await Promise.all([
    readFile(new URL('index.html', dist), 'utf8'),
    readFile(new URL('sw.js', dist), 'utf8'),
    readFile(new URL('manifest.webmanifest', dist), 'utf8')
  ]);

  assert.match(html, /<html|<!doctype html/i);
  assert.match(worker, /precacheAndRoute/);
  const parsedManifest = JSON.parse(manifest);
  assert.equal(parsedManifest.name, 'CountAI by AIVON');
  assert.equal(parsedManifest.start_url, '/');
  assert.equal(parsedManifest.scope, '/');
});

test('CCTV-first production build does not ship the legacy local photo detector', async () => {
  const names = await readdir(assets);
  assert.ok(!names.some(name => /^localDetector-.+\.js$/.test(name)), 'legacy photo detector must not be shipped in the CCTV-first bundle');

  const worker = await readFile(new URL('sw.js', dist), 'utf8');
  const precacheStart = worker.indexOf('precacheAndRoute(');
  assert.notEqual(precacheStart, -1, 'service worker should define a precache manifest');
  const routeStart = worker.indexOf('registerRoute(', precacheStart);
  assert.notEqual(routeStart, -1, 'service worker should define runtime routes');
  const precacheSection = worker.slice(precacheStart, routeStart);
  assert.doesNotMatch(precacheSection, /localDetector-[^"']+\.js/, 'large detector must not be in install-time precache');
});

test('detector runtime cache remains bounded and expires old entries', async () => {
  const worker = await readFile(new URL('sw.js', dist), 'utf8');
  assert.match(worker, /countai-detector-assets/);
  assert.match(worker, /CacheFirst/);
  assert.match(worker, /maxEntries\s*:\s*2/);
  assert.match(worker, /maxAgeSeconds\s*:\s*(?:2592000|2592e3)/);
});
