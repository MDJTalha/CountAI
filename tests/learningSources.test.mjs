import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteLearningSourceStore, validateLearningSourceInput } from '../server/spais/learningSources.mjs';

test('learning source validation requires tenant scope, explicit authorization, and source-specific content', () => {
  const base = { siteId: 'site-1', sourceType: 'observation', title: 'Doorway queue', contentText: 'Queue length increased', consentConfirmed: true };
  assert.equal(validateLearningSourceInput(base).valid, true);
  assert.ok(validateLearningSourceInput({ ...base, consentConfirmed: false }).errors.includes('explicit_data_authorization_required'));
  assert.ok(validateLearningSourceInput({ ...base, sourceType: 'image' }).errors.includes('image_file_required'));
  assert.ok(validateLearningSourceInput({ ...base, siteId: '../other-site' }).errors.includes('site_id_required'));
  assert.ok(validateLearningSourceInput({ ...base, streamUrl: 'rtsp://camera/private' }).errors.includes('unsupported_field:streamUrl'));
  assert.ok(validateLearningSourceInput({ ...base, sourceType: 'video_recording', contentText: undefined }).errors.includes('video_file_required'));
});

test('learning sources persist scoped observations and safely store a verified image asset', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'countai-learning-sources-'));
  try {
    const store = createSqliteLearningSourceStore({ databasePath: ':memory:', mediaDirectory: dir });
    const observation = await store.create({
      organizationId: 'org-1', principal: { subjectId: 'operator-1' },
      input: {
        siteId: 'site-1', sourceType: 'observation', title: 'Queue observation',
        contentText: 'At 09:15 the east entrance queue reached six people.',
        observedAt: '2026-10-24T09:15:00.000Z', cameraId: 'cam-east',
        labels: ['queue', 'entrance'], consentConfirmed: true
      }
    });
    assert.equal(observation.createdBy, 'operator-1');
    assert.equal(observation.status, 'ready_for_review');
    assert.equal(observation.learningState, 'queued_for_review');
    assert.equal(observation.contentText, 'At 09:15 the east entrance queue reached six people.');

    const png = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
    const image = await store.create({
      organizationId: 'org-1', principal: { subjectId: 'operator-1' },
      input: {
        siteId: 'site-1', sourceType: 'image', title: 'Reference frame',
        description: 'Approved reference image for later human annotation.',
        fileName: 'reference.png', mimeType: 'image/png', fileBase64: png.toString('base64'),
        labels: ['entrance'], consentConfirmed: true
      }
    });
    assert.equal(image.mediaStored, true);
    assert.equal(image.byteSize, png.length);
    assert.match(image.sha256, /^[a-f0-9]{64}$/);
    assert.equal(image.status, 'awaiting_annotation');
    const files = await (await import('node:fs/promises')).readdir(dir);
    assert.equal(files.length, 1);
    const stored = await readFile(join(dir, files[0]));
    assert.deepEqual(stored, png);

    const scoped = await store.list({ organizationId: 'org-1', siteId: 'site-1' });
    assert.equal(scoped.length, 2);
    assert.equal((await store.list({ organizationId: 'org-2', siteId: 'site-1' })).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('learning source validation rejects oversized files and unsupported secret-like metadata keys', () => {
  const common = { siteId: 'site-1', title: 'Reference image', consentConfirmed: true };
  assert.ok(validateLearningSourceInput({
    ...common, sourceType: 'image', fileName: 'x.png', mimeType: 'image/png',
    fileBase64: 'x'.repeat(12 * 1024 * 1024)
  }).errors.includes('file_payload_too_large_or_missing'));
  assert.ok(validateLearningSourceInput({
    ...common, sourceType: 'observation', contentText: 'observation', consentConfirmed: true,
    apiKey: 'must-not-be-supplied'
  }).errors.includes('unsupported_field:apiKey'));
});
