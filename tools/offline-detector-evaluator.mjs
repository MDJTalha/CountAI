import { createHash, createPrivateKey, randomBytes, randomUUID, sign } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { canonicalizeLearningEvaluationReport } from '../server/spais/learningEvaluations.mjs';

const EVALUATOR_VERSION = 'spais-offline-detector-evaluator/0.1.0';
const MAX_INPUT_BYTES = 250 * 1024 * 1024;
const MAX_SAMPLES = 100000;
const MAX_BOXES_PER_SAMPLE = 1000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function finiteUnit(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1; }

function validateBox(box, prediction, where) {
  assert(box && typeof box === 'object' && !Array.isArray(box), where + ': box must be an object');
  const allowed = prediction
    ? new Set(['className', 'x', 'y', 'width', 'height', 'confidence'])
    : new Set(['className', 'x', 'y', 'width', 'height']);
  for (const key of Object.keys(box)) assert(allowed.has(key), where + ': unsupported box field ' + key);
  assert(typeof box.className === 'string' && box.className.trim().length > 0 && box.className.trim().length <= 64, where + ': invalid className');
  for (const key of ['x', 'y', 'width', 'height']) {
    assert(finiteUnit(box[key]), where + ': ' + key + ' must be between 0 and 1');
  }
  assert(box.width > 0 && box.height > 0, where + ': box dimensions must be positive');
  assert(box.x + box.width <= 1.000001 && box.y + box.height <= 1.000001, where + ': box must fit inside normalized frame coordinates');
  if (prediction) assert(finiteUnit(box.confidence), where + ': confidence must be between 0 and 1');
}

export function validateDetectorBundle(bundle) {
  assert(bundle && typeof bundle === 'object' && !Array.isArray(bundle), 'evaluation bundle must be an object');
  assert(bundle.schemaVersion === 1, 'evaluation bundle schemaVersion must be 1');
  assert(Array.isArray(bundle.samples) && bundle.samples.length > 0 && bundle.samples.length <= MAX_SAMPLES, 'samples must contain 1 to 100000 records');
  const sampleIds = new Set();
  bundle.samples.forEach((sample, index) => {
    const where = 'samples[' + index + ']';
    assert(sample && typeof sample === 'object' && !Array.isArray(sample), where + ': sample must be an object');
    for (const key of Object.keys(sample)) assert(['id', 'groundTruth', 'predictions'].includes(key), where + ': unsupported field ' + key);
    assert(typeof sample.id === 'string' && sample.id.trim().length > 0 && sample.id.length <= 128, where + ': invalid sample id');
    assert(!sampleIds.has(sample.id), where + ': duplicate sample id');
    sampleIds.add(sample.id);
    assert(Array.isArray(sample.groundTruth) && sample.groundTruth.length <= MAX_BOXES_PER_SAMPLE, where + ': invalid groundTruth array');
    assert(Array.isArray(sample.predictions) && sample.predictions.length <= MAX_BOXES_PER_SAMPLE, where + ': invalid predictions array');
    sample.groundTruth.forEach((box, boxIndex) => validateBox(box, false, where + '.groundTruth[' + boxIndex + ']'));
    sample.predictions.forEach((box, boxIndex) => validateBox(box, true, where + '.predictions[' + boxIndex + ']'));
  });
  return { sampleCount: bundle.samples.length };
}

export function validateThresholdArtifact(artifact) {
  assert(artifact && typeof artifact === 'object' && !Array.isArray(artifact), 'candidate artifact must be a JSON object');
  for (const key of Object.keys(artifact)) {
    assert(['schemaVersion', 'confidenceThreshold', 'iouThreshold'].includes(key), 'unsupported threshold artifact field ' + key);
  }
  assert(artifact.schemaVersion === 1, 'threshold artifact schemaVersion must be 1');
  assert(finiteUnit(artifact.confidenceThreshold), 'confidenceThreshold must be between 0 and 1');
  assert(finiteUnit(artifact.iouThreshold), 'iouThreshold must be between 0 and 1');
  return { confidenceThreshold: artifact.confidenceThreshold, iouThreshold: artifact.iouThreshold };
}

function intersectionOverUnion(a, b) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 ? intersection / union : 0;
}

/** Evaluate precomputed candidate-model detections against labelled holdout boxes. */
export function evaluateDetectorBundle(bundle, artifact) {
  validateDetectorBundle(bundle);
  const thresholds = validateThresholdArtifact(artifact);
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let imagesWithFalsePositives = 0;
  for (const sample of bundle.samples) {
    const groundTruth = sample.groundTruth;
    const predictions = sample.predictions
      .filter(prediction => prediction.confidence >= thresholds.confidenceThreshold)
      .sort((a, b) => b.confidence - a.confidence);
    const matched = new Set();
    let sampleFalsePositives = 0;
    for (const prediction of predictions) {
      let bestIndex = -1;
      let bestIou = -1;
      for (let index = 0; index < groundTruth.length; index += 1) {
        if (matched.has(index) || groundTruth[index].className !== prediction.className) continue;
        const iou = intersectionOverUnion(groundTruth[index], prediction);
        if (iou >= thresholds.iouThreshold && iou > bestIou) {
          bestIou = iou;
          bestIndex = index;
        }
      }
      if (bestIndex >= 0) {
        matched.add(bestIndex);
        truePositives += 1;
      } else {
        falsePositives += 1;
        sampleFalsePositives += 1;
      }
    }
    falseNegatives += groundTruth.length - matched.size;
    if (sampleFalsePositives > 0) imagesWithFalsePositives += 1;
  }
  const sampleCount = bundle.samples.length;
  return {
    sampleCount,
    truePositives,
    falsePositives,
    falseNegatives,
    imagesWithFalsePositives,
    precision: truePositives + falsePositives > 0 ? truePositives / (truePositives + falsePositives) : 0,
    recall: truePositives + falseNegatives > 0 ? truePositives / (truePositives + falseNegatives) : 0,
    // Defined here as the fraction of evaluated images with at least one unmatched detection.
    falsePositiveRate: imagesWithFalsePositives / sampleCount,
    confidenceThreshold: thresholds.confidenceThreshold,
    iouThreshold: thresholds.iouThreshold
  };
}

export function buildSignedEvaluationReport({ candidate, metrics, privateKey, now = new Date() }) {
  assert(candidate && candidate.status === 'evaluation_pending', 'candidate must be approved for offline evaluation');
  assert(typeof candidate.organizationId === 'string' && typeof candidate.siteId === 'string' && typeof candidate.id === 'string', 'candidate manifest must include trusted scope and ID');
  const report = {
    runId: randomUUID(),
    artifactSha256: candidate.artifactSha256,
    evaluationDatasetSha256: candidate.evaluationDatasetSha256,
    evaluatorVersion: EVALUATOR_VERSION,
    evaluatedAt: now.toISOString(),
    nonce: randomBytes(24).toString('base64url'),
    sampleCount: metrics.sampleCount,
    precision: Number(metrics.precision.toFixed(8)),
    recall: Number(metrics.recall.toFixed(8)),
    falsePositiveRate: Number(metrics.falsePositiveRate.toFixed(8))
  };
  report.signature = sign('RSA-SHA256', canonicalizeLearningEvaluationReport({
    organizationId: candidate.organizationId, siteId: candidate.siteId, candidateId: candidate.id, report
  }), privateKey).toString('base64url');
  return report;
}

async function readBoundedFile(path, maxBytes = MAX_INPUT_BYTES) {
  const metadata = await stat(path);
  assert(metadata.size > 0 && metadata.size <= maxBytes, 'input file size must be between 1 byte and ' + maxBytes);
  return readFile(path);
}

function parseArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    assert(key.startsWith('--') && index + 1 < args.length, 'arguments must be --name value pairs');
    values.set(key.slice(2), args[++index]);
  }
  for (const key of ['candidate', 'artifact', 'dataset', 'private-key']) assert(values.has(key), 'missing required --' + key + ' argument');
  return values;
}

export async function runOfflineEvaluatorCli(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  const candidateBytes = await readBoundedFile(options.get('candidate'));
  const artifactBytes = await readBoundedFile(options.get('artifact'));
  const datasetBytes = await readBoundedFile(options.get('dataset'));
  const candidateDocument = JSON.parse(candidateBytes.toString('utf8'));
  const candidate = candidateDocument?.candidate || candidateDocument;
  assert(candidate && candidate.status === 'evaluation_pending', 'candidate manifest must be approved for offline evaluation');
  assert(candidate.changeType === 'thresholds', 'reference evaluator currently supports threshold candidates only');
  assert(sha256(artifactBytes) === candidate.artifactSha256, 'candidate artifact SHA-256 does not match the registered digest');
  assert(sha256(datasetBytes) === candidate.evaluationDatasetSha256, 'evaluation dataset SHA-256 does not match the registered digest');
  const artifact = JSON.parse(artifactBytes.toString('utf8'));
  const bundle = JSON.parse(datasetBytes.toString('utf8'));
  const metrics = evaluateDetectorBundle(bundle, artifact);
  const privateKeyBytes = await readBoundedFile(options.get('private-key'), 1024 * 1024);
  const privateKeyPath = options.get('private-key');
  const privateKeyMetadata = await stat(privateKeyPath);
  if (process.platform !== 'win32') {
    assert((privateKeyMetadata.mode & 0o077) === 0, 'evaluator private key permissions must be owner-only (chmod 600)');
  }
  const privateKey = createPrivateKey(privateKeyBytes);
  assert(privateKey.asymmetricKeyType === 'rsa' && (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) >= 2048, 'evaluator key must be RSA with at least 2048 bits');
  const report = buildSignedEvaluationReport({ candidate, metrics, privateKey });
  const serialized = JSON.stringify(report, null, 2) + '\n';
  if (options.has('output')) {
    await writeFile(options.get('output'), serialized, { mode: 0o600, flag: 'wx' });
    process.stderr.write('Signed offline evaluation report written. Submit it through the authenticated SPAIS evaluator endpoint.\n');
  } else {
    process.stdout.write(serialized);
  }
  process.stderr.write(JSON.stringify({
    summary: 'offline_detector_evaluation',
    sampleCount: metrics.sampleCount,
    truePositives: metrics.truePositives,
    falsePositives: metrics.falsePositives,
    falseNegatives: metrics.falseNegatives,
    precision: metrics.precision,
    recall: metrics.recall,
    falsePositiveRate: metrics.falsePositiveRate,
    confidenceThreshold: metrics.confidenceThreshold,
    iouThreshold: metrics.iouThreshold
  }) + '\n');
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runOfflineEvaluatorCli().catch(error => {
    process.stderr.write('Offline evaluation failed: ' + (error instanceof Error ? error.message : 'unknown error') + '\n');
    process.exitCode = 1;
  });
}
