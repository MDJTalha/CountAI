import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const playwrightModule = process.env.COUNT_AI_PLAYWRIGHT_MODULE;
if (!playwrightModule) {
  throw new Error('Set COUNT_AI_PLAYWRIGHT_MODULE to the absolute Playwright module path before running browser smoke tests.');
}
const { chromium } = await import(playwrightModule);
const previewUrl = 'http://127.0.0.1:4173';
const server = spawn(process.execPath, [
  'node_modules/vite/bin/vite.js', 'preview',
  '--host', '127.0.0.1', '--port', '4173', '--strictPort',
], { stdio: 'ignore' });
let browser;

async function waitForPreview() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Vite preview exited with code ${server.exitCode}`);
    try {
      const response = await fetch(previewUrl);
      if (response.ok) return;
    } catch {
      // Vite has not bound the port yet.
    }
    await delay(250);
  }
  throw new Error('Vite preview did not become ready within 30 seconds.');
}

try {
  await waitForPreview();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  await page.goto(previewUrl, { waitUntil: 'domcontentloaded' });
  assert.match(await page.title(), /SPAIS/);

  const nav = page.getByRole('navigation', { name: 'Main workspace' });
  for (const label of [
    'Overview', 'Live Counter', 'Photo Review', 'History', 'Analytics',
    'Governance, AI & SOPs', 'Sites & Cameras',
  ]) {
    const button = nav.getByRole('button', { name: label });
    await button.click();
    assert.equal(await button.getAttribute('aria-pressed'), 'true', `Workspace did not activate: ${label}`);
  }

  await page.setViewportSize({ width: 375, height: 812 });
  const navDimensions = await nav.evaluate(element => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  assert.ok(navDimensions.clientWidth > 0, 'Mobile navigation should be visible');
  assert.ok(navDimensions.scrollWidth >= navDimensions.clientWidth, 'Mobile navigation must remain scrollable when labels overflow');

  await nav.getByRole('button', { name: 'Photo Review' }).click();
  const addManually = page.getByRole('button', { name: 'Add manually' });
  await addManually.click();
  const dialog = page.getByRole('dialog', { name: 'Correct detection' });
  await dialog.waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await addManually.evaluate(element => element === document.activeElement), true, 'Closing the dialog should restore focus to its opener');

  await addManually.click();
  await page.locator('#edit-category').fill('person');
  await page.locator('#edit-confidence').fill('1.2');
  await dialog.getByRole('button', { name: 'Save correction' }).click();
  await page.getByText('Confidence must be a number from 0 to 1.').waitFor({ state: 'visible' });
  await dialog.waitFor({ state: 'visible', timeout: 2_000 });

  await page.locator('#edit-confidence').fill('0.7');
  await dialog.getByRole('button', { name: 'Save correction' }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByText('Correction saved. Category totals have been recalculated.').waitFor({ state: 'visible' });
  assert.deepEqual(pageErrors, [], `Unexpected browser runtime errors: ${pageErrors.join('; ')}`);

  console.log('Browser smoke passed: navigation, mobile viewport, dialog keyboard behavior, confidence validation, and correction persistence.');
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
