import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { isResourceId } from './contracts.mjs';

const SHA256 = /^[a-f0-9]{64}$/i;
const NONCE = /^[A-Za-z0-9_-]{22,128}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{256,1024}$/;
const MAX_AGE_MS = 15 * 60 * 1000;

function validText(value, max) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max;
}

export function validateLearningEvaluationReport(report, now = new Date()) {
  const errors = [];
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    return { valid: false, errors: ['body_must_be_object'] };
  }
  const allowed = new Set([
    'runId', 'artifactSha256', 'evaluationDatasetSha256', 'evaluatorVersion',
    'evaluatedAt', 'nonce', 'sampleCount', 'precision', 'recall',
    'falsePositiveRate', 'signature'
  ]);
  for (const key of Object.keys(report)) if (!allowed.has(key)) errors.push('unsupported_field:' + key);
  if (!isResourceId(report.runId)) errors.push('invalid_run_id');
  if (typeof report.artifactSha256 !== 'string' || !SHA256.test(report.artifactSha256)) errors.push('invalid_artifact_sha256');
  if (typeof report.evaluationDatasetSha256 !== 'string' || !SHA256.test(report.evaluationDatasetSha256)) errors.push('invalid_evaluation_dataset_sha256');
  if (!validText(report.evaluatorVersion, 64)) errors.push('invalid_evaluator_version');
  const evaluatedAt = typeof report.evaluatedAt === 'string' ? Date.parse(report.evaluatedAt) : NaN;
  if (!Number.isFinite(evaluatedAt)) errors.push('invalid_evaluated_at');
  else if (Math.abs(now.getTime() - evaluatedAt) > MAX_AGE_MS || evaluatedAt > now.getTime() + 5 * 60 * 1000) {
    errors.push('evaluation_attestation_out_of_window');
  }
  if (typeof report.nonce !== 'string' || !NONCE.test(report.nonce)) errors.push('invalid_evaluation_nonce');
  if (!Number.isSafeInteger(report.sampleCount) || report.sampleCount < 1 || report.sampleCount > 10000000) errors.push('invalid_sample_count');
  for (const metric of ['precision', 'recall', 'falsePositiveRate']) {
    if (typeof report[metric] !== 'number' || !Number.isFinite(report[metric]) || report[metric] < 0 || report[metric] > 1) {
      errors.push('invalid_metric:' + metric);
    }
  }
  if (typeof report.signature !== 'string' || !SIGNATURE.test(report.signature)) errors.push('invalid_evaluator_signature');
  return { valid: errors.length === 0, errors };
}

/** Stable ordered bytes signed by the independently operated evaluator service. */
export function canonicalizeLearningEvaluationReport({ organizationId, siteId, candidateId, report }) {
  const fields = [
    organizationId, siteId, candidateId, report.runId, report.artifactSha256.toLowerCase(),
    report.evaluationDatasetSha256.toLowerCase(), report.evaluatorVersion,
    new Date(Date.parse(report.evaluatedAt)).toISOString(), report.nonce,
    String(report.sampleCount), String(report.precision), String(report.recall), String(report.falsePositiveRate)
  ];
  if (![organizationId, siteId, candidateId].every(isResourceId) || fields.some(value => typeof value !== 'string')) {
    throw Object.assign(new Error('invalid_learning_evaluation_scope'), { code: 'invalid_learning_evaluation_scope' });
  }
  return Buffer.from('spais-learning-evaluation-v1\n' + fields.join('\n'), 'utf8');
}

export function getTrustedLearningEvaluatorConfig(env = process.env) {
  try {
    if (!env.SPAIS_EVALUATOR_PUBLIC_KEY_JWK) return null;
    const jwk = JSON.parse(env.SPAIS_EVALUATOR_PUBLIC_KEY_JWK);
    if (!jwk || jwk.kty !== 'RSA' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') return null;
    const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
    if (publicKey.asymmetricKeyType !== 'rsa' || (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) return null;
    const minSampleCount = Number(env.SPAIS_EVALUATION_MIN_SAMPLE_COUNT);
    const minPrecision = Number(env.SPAIS_EVALUATION_MIN_PRECISION);
    const minRecall = Number(env.SPAIS_EVALUATION_MIN_RECALL);
    const maxFalsePositiveRate = Number(env.SPAIS_EVALUATION_MAX_FALSE_POSITIVE_RATE);
    if (!Number.isSafeInteger(minSampleCount) || minSampleCount < 1 ||
        !Number.isFinite(minPrecision) || minPrecision < 0 || minPrecision > 1 ||
        !Number.isFinite(minRecall) || minRecall < 0 || minRecall > 1 ||
        !Number.isFinite(maxFalsePositiveRate) || maxFalsePositiveRate < 0 || maxFalsePositiveRate > 1) return null;
    return {
      publicKey,
      keyId: validText(env.SPAIS_EVALUATOR_KEY_ID, 128) ? env.SPAIS_EVALUATOR_KEY_ID.trim() : 'configured-rsa-key',
      thresholds: { minSampleCount, minPrecision, minRecall, maxFalsePositiveRate }
    };
  } catch {
    return null;
  }
}

export function verifyLearningEvaluationAttestation({ organizationId, siteId, candidateId, report, evaluatorConfig, now = new Date() }) {
  const validation = validateLearningEvaluationReport(report, now);
  if (!validation.valid || !evaluatorConfig?.publicKey) {
    return { valid: false, reason: !evaluatorConfig?.publicKey ? 'trusted_evaluator_not_configured' : 'invalid_evaluation_report', errors: validation.errors };
  }
  let signedBytes;
  let signatureBytes;
  try {
    signedBytes = canonicalizeLearningEvaluationReport({ organizationId, siteId, candidateId, report });
    signatureBytes = Buffer.from(report.signature, 'base64url');
  } catch {
    return { valid: false, reason: 'invalid_evaluation_attestation' };
  }
  if (!verifySignature('RSA-SHA256', signedBytes, evaluatorConfig.publicKey, signatureBytes)) {
    return { valid: false, reason: 'invalid_evaluator_signature' };
  }
  const thresholds = evaluatorConfig.thresholds;
  const passed = report.sampleCount >= thresholds.minSampleCount &&
    report.precision >= thresholds.minPrecision &&
    report.recall >= thresholds.minRecall &&
    report.falsePositiveRate <= thresholds.maxFalsePositiveRate;
  const attestationSha256 = createHash('sha256').update(signedBytes).update(signatureBytes).digest('hex');
  return {
    valid: true,
    attestationSha256,
    evaluatorKeyId: evaluatorConfig.keyId,
    result: passed ? 'passed' : 'failed',
    thresholds
  };
}
