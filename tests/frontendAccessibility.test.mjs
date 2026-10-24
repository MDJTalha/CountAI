import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/accessibility.css', import.meta.url), 'utf8');
const entry = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');

test('detection correction dialog supports Escape and keyboard focus containment', () => {
  assert.match(app, /event\.key === 'Escape'/);
  assert.match(app, /event\.key !== 'Tab'/);
  assert.match(app, /event\.shiftKey && document\.activeElement === first/);
  assert.match(app, /document\.activeElement === last/);
  assert.match(app, /focusable\(\)\[0\]\?\.focus\(\)/);
  assert.match(app, /restoreFocusRef\.current\?\.focus\(\)/);
});

test('correction form validates confidence before updating detections', () => {
  assert.match(app, /Number\.isFinite\(Number\(editConfidence\)\)/);
  assert.match(app, /Number\(editConfidence\) < 0/);
  assert.match(app, /Number\(editConfidence\) > 1/);
});

test('persistence failure cannot be replaced by a false save-success notice', () => {
  assert.match(app, /async function persist\(list = detections\): Promise<boolean>/);
  assert.match(app, /if \(await persist\(updated\)\) notify\('Correction saved/);
  assert.match(app, /could not save this session\.', true\); return false/);
});

test('accessibility stylesheet is included in the application entry point', () => {
  assert.match(entry, /import '\.\/accessibility\.css'/);
});

test('interactive controls expose visible keyboard focus', () => {
  assert.match(styles, /:focus-visible/);
  assert.match(styles, /outline: 3px solid/);
});

test('mobile workspace navigation supports horizontal touch scrolling', () => {
  assert.match(styles, /\.workspace-nav[\s\S]*?overscroll-behavior-inline: contain/);
  assert.match(styles, /overflow-x: auto/);
  assert.match(styles, /min-height: 42px/);
});

test('motion preferences are respected', () => {
  assert.match(styles, /prefers-reduced-motion: reduce/);
  assert.match(styles, /animation-duration: 0\.01ms/);
});


test('operator-facing copy does not contain common UTF-8 mojibake', () => {
  for (const brokenSequence of ['â€¦', 'Â·', 'â€œ', 'â€', '0â€“1']) {
    assert.equal(app.includes(brokenSequence), false, `Found corrupted display text: ${brokenSequence}`);
  }
  assert.match(app, /CONFIDENCE \(0–1, OPTIONAL\)/);
});


test('all primary workspaces are reachable through named, stateful navigation controls', () => {
  for (const label of ['Overview', 'Live Counter', 'Photo Review', 'History', 'Analytics', 'Governance, AI &amp; SOPs', 'Sites &amp; Cameras']) {
    assert.ok(app.includes(label), `Missing workspace navigation label: ${label}`);
  }
  assert.match(app, /<nav className="workspace-nav" aria-label="Main workspace">/);
  assert.match(app, /aria-pressed=\{activeWorkspace === 'dashboard'\}/);
  assert.match(app, /aria-pressed=\{activeWorkspace === 'operations'\}/);
  assert.match(app, /setActiveWorkspace\('governance'\)/);
  assert.match(app, /setActiveWorkspace\('operations'\)/);
});


test('camera tracks are not stopped by unrelated photo URL changes', () => {
  assert.match(app, /useEffect\(\(\) => \(\) => \{ if \(imageUrl\) URL\.revokeObjectURL\(imageUrl\); \}, \[imageUrl\]\)/);
  assert.match(app, /useEffect\(\(\) => \(\) => \{ stream\?\.getTracks\(\)\.forEach\(t => t\.stop\(\)\); \}, \[stream\]\)/);
  assert.doesNotMatch(app, /URL\.revokeObjectURL\(imageUrl\); stream\?\.getTracks\(\)\.forEach/);
});
