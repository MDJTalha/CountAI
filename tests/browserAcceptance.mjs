import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const baseUrl = 'http://127.0.0.1:4173';
const server = spawn('npm', ['run', 'preview', '--', '--host', '127.0.0.1', '--port', '4173', '--strictPort'], {
  stdio: 'ignore',
  env: { ...process.env, BROWSER: 'none' }
});
let browser;

async function waitForPreview() {
  const deadline = Date.now() + 20000;
  let lastError;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error('Vite preview exited before becoming ready');
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch (error) { lastError = error; }
    await delay(200);
  }
  throw new Error('Vite preview did not become ready: ' + (lastError?.message || 'timeout'));
}

try {
  await waitForPreview();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Every camera. One operational view.' }).waitFor();

  // Keyboard users can skip repeated navigation and focus the main workspace.
  await page.keyboard.press('Tab');
  assert.match(await page.evaluate(() => document.activeElement?.textContent || ''), /Skip to main content/);
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'main-content');

  await page.getByRole('button', { name: /Live monitoring/ }).click();
  await page.getByRole('heading', { name: 'Live camera monitoring' }).waitFor();
  await page.getByText('NO VERIFIED STREAM', { exact: true }).waitFor();

  await page.getByRole('button', { name: /Sites & cameras/ }).click();
  await page.getByRole('heading', { name: 'Sites, cameras & connectors' }).waitFor();
  await page.getByRole('button', { name: 'Connect & refresh' }).click();
  await page.getByText('Enter organization ID and a trusted bearer token.', { exact: true }).waitFor();

  await page.getByRole('button', { name: /Incidents & AI/ }).click();
  await page.getByRole('heading', { name: 'Governance and operational assurance' }).waitFor();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: /Overview/ }).click();
  const mobileLayout = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth
  }));
  assert.ok(
    mobileLayout.document <= mobileLayout.viewport + 1,
    'mobile layout should not create document-level horizontal overflow: ' + JSON.stringify(mobileLayout)
  );
  assert.deepEqual(pageErrors, [], 'browser should not emit uncaught page errors');

  process.stdout.write(JSON.stringify({
    test: 'countai-browser-acceptance-smoke',
    passed: ['overview render', 'skip-link keyboard navigation', 'live monitoring honest stream state',
      'sites/cameras validation feedback', 'governance navigation', 'mobile viewport overflow'],
    pageErrors
  }, null, 2) + '\n');
} finally {
  if (browser) await browser.close();
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(2000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
}
