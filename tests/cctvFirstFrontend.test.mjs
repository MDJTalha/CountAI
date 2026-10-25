import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [entrypoint, app, operations, learning, styles, html, readme] = await Promise.all([
  readFile(new URL('../src/main.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/CctvFirstApp.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/SpaisOperationsWorkspace.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/SpaisLearningLab.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/CctvFirstApp.css', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../README.md', import.meta.url), 'utf8')
]);

test('CCTV-first app is the production entrypoint, not the legacy photo-counting app', () => {
  assert.match(entrypoint, /import\s+\{\s*CctvFirstApp\s*\}\s+from\s+['"]\.\/CctvFirstApp['"]/);
  assert.match(entrypoint, /<CctvFirstApp\s*\/>/);
  assert.doesNotMatch(entrypoint, /import\s+\{\s*App\s*\}\s+from\s+['"]\.\/App['"]/);
});

test('primary navigation contains operational CCTV workspaces, not photo detection', () => {
  for (const label of ['Overview', 'Live monitoring', 'Sites & cameras', 'Incidents & AI']) {
    assert.ok(app.includes(label), `Expected navigation/workspace: ${label}`);
  }
  assert.doesNotMatch(app, /Photo count|Choose a photo|upload a photo|ImagePlus/);
});

test('live view clearly refuses to claim a feed until a stream adapter is connected', () => {
  assert.match(app, /NO VERIFIED STREAM/);
  assert.match(app, /Adapter required/);
  assert.match(app, /Creating a camera record does not establish a video stream/);
  assert.match(app, /will not scan the network, guess camera credentials/);
});

test('camera registration captures compatibility metadata without accepting secrets', () => {
  assert.match(readme, /metadata/i);
  assert.match(readme, /RTSP/i);
  assert.match(operations, /cameraProtocol/);
  assert.match(operations, /cameraTransport/);
  assert.match(operations, /Do not enter stream URLs, passwords, tokens, or private keys here/);
  assert.match(operations, /integrationState: 'not_configured'/);
});

test('camera and recorder integration targets are represented honestly', () => {
  for (const label of ['IP camera', 'NVR / DVR', 'ONVIF', 'RTSP / vendor API']) assert.ok(app.includes(label));
  assert.match(app, /Bluetooth is generally for setup\/provisioning/);
  assert.match(app, /not universal video protocols/);
});

test('CCTV-first layout includes responsive mobile breakpoints and accessible navigation', () => {
  assert.match(styles, /@media\(max-width:760px\)/);
  assert.match(app, /aria-label="Primary navigation"/);
  assert.match(app, /aria-current=/);
  assert.match(html, /CCTV-first|camera-first|camera intelligence/i);
});

test('documentation describes the CCTV-first product boundary', () => {
  assert.match(readme, /CCTV-first/i);
  assert.match(readme, /RTSP/i);
  assert.match(readme, /Bluetooth/i);
  assert.match(readme, /not proof that footage exists|not independently verified|not proof that a camera is online/i);
});

test('autonomous learning workbench accepts authorized sources but does not claim training or live recording is complete', () => {
  for (const kind of ['document', 'image', 'observation', 'video_recording']) assert.ok(learning.includes(`value="${kind}"`));
  assert.match(learning, /consentConfirmed: true/);
  assert.match(learning, /8 MB/);
  assert.match(learning, /[Hh]uman review\/annotation is still required/);
  assert.match(learning, /Direct continuous capture from network CCTV requires the stream adapter/);
  assert.match(readme, /does not yet extract text from PDFs, run image\/video inference/);
});


test('CCTV-first console keeps keyboard focus visible and respects reduced-motion preferences', () => {
  assert.match(styles, /:focus-visible/);
  assert.match(styles, /outline: 3px solid/);
  assert.match(styles, /prefers-reduced-motion: reduce/);
  assert.match(styles, /animation-duration: 0\.01ms/);
  assert.match(styles, /transition-duration: 0\.01ms/);
});


test('keyboard users can skip primary navigation to the main workspace', () => {
  assert.match(app, /className="cctv-skip-link" href="#main-content">Skip to main content/);
  assert.match(app, /<main id="main-content" className="cctv-main" tabIndex=\{-1\}>/);
  assert.match(styles, /\.cctv-skip-link:focus/);
  assert.match(styles, /#main-content:focus\s*\{\s*outline: 3px solid/);
});
