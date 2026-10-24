import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  buildSignedEvaluationReport,
  evaluateDetectorBundle,
  validateDetectorBundle,
  validateThresholdArtifact
} from '../tools/offline-detector-evaluator.mjs';
import { verifyLearningEvaluationAttestation } from '../server/spais/learningEvaluations.mjs';

const artifact = { schemaVersion: 1, confidenceThreshold: 0.5, iouThreshold: 0.5 };
const bundle = {
  schemaVersion: 1,
  samples: [
    {
      id: 'frame-001',
      groundTruth: [{ className: 'car', x: 0.1, y: 0.1, width: 0.2, height: 0.2 }],
      predictions: [
        { className: 'car', x: 0.1, y: 0.1, width: 0.2, height: 0.2, confidence: 0.95 },
        { className: 'car', x: 0.7, y: 0.7, width: 0.1, height: 0.1, confidence: 0.75 }
      ]
    },
    {
      id: 'frame-002',
      groundTruth: [{ className: 'person', x: 0.4, y: 0.4, width: 0.2, height: 0.2 }],
      predictions: [{ className: 'person', x: 0.4, y: 0.4, width: 0.2, height: 0.2, confidence: 0.3 }]
    }
  ]
};

test('offline evaluator computes IoU matches, false positives, false negatives and image-level false-positive rate', () => {
  const metrics = evaluateDetectorBundle(bundle, artifact);
  assert.equal(metrics.sampleCount, 2);
  assert.equal(metrics.truePositives, 1);
  assert.equal(metrics.falsePositives, 1);
  assert.equal(metrics.falseNegatives, 1);
  assert.equal(metrics.imagesWithFalsePositives, 1);
  assert.equal(metrics.precision, 0.5);
  assert.equal(metrics.recall, 0.5);
  assert.equal(metrics.falsePositiveRate, 0.5);
});

test('offline evaluator rejects malformed labels, duplicate samples and unsupported threshold fields', () => {
  assert.throws(() => validateDetectorBundle({
    schemaVersion: 1,
    samples: [{ id: 'same', groundTruth: [], predictions: [] }, { id: 'same', groundTruth: [], predictions: [] }]
  }), /duplicate sample id/);
  assert.throws(() => validateDetectorBundle({
    schemaVersion: 1,
    samples: [{ id: 'frame', groundTruth: [], predictions: [{ className: 'car', x: 0.9, y: 0.9, width: 0.3, height: 0.1, confidence: 0.9 }] }]
  }), /fit inside normalized frame coordinates/);
  assert.throws(() => validateThresholdArtifact({ ...artifact, deploy: true }), /unsupported threshold artifact field/);
});

test('signed offline report binds the candidate scope and metrics to the trusted evaluator key', () => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const candidate = {
    id: 'candidate-1', organizationId: 'org-1', siteId: 'site-1', status: 'evaluation_pending',
    artifactSha256: 'a'.repeat(64), evaluationDatasetSha256: 'b'.repeat(64)
  };
  const report = buildSignedEvaluationReport({
    candidate,
    metrics: { sampleCount: 200, precision: 0.98, recall: 0.95, falsePositiveRate: 0.01 },
    privateKey: keys.privateKey
  });
  const evaluatorConfig = {
    publicKey: keys.publicKey, keyId: 'offline-test-key',
    thresholds: { minSampleCount: 100, minPrecision: 0.95, minRecall: 0.9, maxFalsePositiveRate: 0.05 }
  };
  const verified = verifyLearningEvaluationAttestation({
    organizationId: 'org-1', siteId: 'site-1', candidateId: 'candidate-1', report, evaluatorConfig
  });
  assert.equal(verified.valid, true);
  assert.equal(verified.result, 'passed');
  assert.equal(verified.evaluatorKeyId, 'offline-test-key');
  const tampered = verifyLearningEvaluationAttestation({
    organizationId: 'org-1', siteId: 'site-1', candidateId: 'candidate-1',
    report: { ...report, precision: 0.1 }, evaluatorConfig
  });
  assert.equal(tampered.valid, false);
  assert.equal(tampered.reason, 'invalid_evaluator_signature');
});

test('offline report generation refuses candidates not approved for evaluation', () => {
  assert.throws(() => buildSignedEvaluationReport({
    candidate: { id: 'candidate-1', organizationId: 'org-1', siteId: 'site-1', status: 'proposed' },
    metrics: { sampleCount: 100, precision: 1, recall: 1, falsePositiveRate: 0 },
    privateKey: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
  }), /approved for offline evaluation/);
});
