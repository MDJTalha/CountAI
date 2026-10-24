import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRecordingCoverageReports, validateRecordingAssuranceQuery } from '../server/spais/recordingAssurance.mjs';

const windowStart = '2026-10-24T00:00:00.000Z';
const windowEnd = '2026-10-24T01:00:00.000Z';
const now = new Date('2026-10-24T01:01:00.000Z');

function report(start, end, recordedSeconds, expectedSeconds, receivedAt = '2026-10-24T01:00:30.000Z') {
  return {
    siteId: 'site-1', connectorId: 'connector-1', receivedAt,
    payload: {
      cameraId: 'camera-1', windowStart: start, windowEnd: end,
      recordedSeconds, expectedSeconds, evidenceDigest: 'a'.repeat(64)
    },
    trustLevel: 'connector-signed-report'
  };
}

test('recording assurance query requires a bounded valid site/camera window', () => {
  assert.equal(validateRecordingAssuranceQuery({
    siteId: 'site-1', cameraId: 'camera-1', windowStart, windowEnd
  }, now).valid, true);
  const tooLong = validateRecordingAssuranceQuery({
    siteId: 'site-1', cameraId: 'camera-1',
    windowStart: '2026-10-01T00:00:00.000Z', windowEnd: '2026-10-10T00:00:00.000Z'
  }, now);
  assert.equal(tooLong.valid, false);
  assert.ok(tooLong.errors.includes('window_exceeds_seven_days'));
  assert.equal(validateRecordingAssuranceQuery({
    siteId: 'site-1', cameraId: 'camera-1', windowStart: windowEnd, windowEnd: windowStart
  }, now).valid, false);
});

test('complete connector reports calculate a reported coverage ratio without claiming independent verification', () => {
  const assessment = evaluateRecordingCoverageReports({
    organizationId: 'org-1', siteId: 'site-1', cameraId: 'camera-1',
    reports: [report(windowStart, windowEnd, 3500, 3600)], windowStart, windowEnd, now
  });
  assert.equal(assessment.reportCount, 1);
  assert.equal(assessment.expectedReportedSeconds, 3600);
  assert.equal(assessment.recordedReportedSeconds, 3500);
  assert.equal(assessment.reportedGapSeconds, 100);
  assert.equal(assessment.reportedCoveragePercent, 97.22);
  assert.equal(assessment.windowContinuity, 'complete');
  assert.equal(assessment.assessment, 'reported_coverage_gap');
  assert.equal(assessment.interpretation, 'reported_not_independently_verified');
});

test('gaps and overlapping report windows cannot be labelled complete', () => {
  const gap = evaluateRecordingCoverageReports({
    organizationId: 'org-1', siteId: 'site-1', cameraId: 'camera-1',
    reports: [
      report(windowStart, '2026-10-24T00:20:00.000Z', 1200, 1200),
      report('2026-10-24T00:25:00.000Z', windowEnd, 2100, 2100)
    ], windowStart, windowEnd, now
  });
  assert.equal(gap.windowContinuity, 'gaps_detected');
  assert.equal(gap.assessment, 'incomplete_report_windows');

  const overlap = evaluateRecordingCoverageReports({
    organizationId: 'org-1', siteId: 'site-1', cameraId: 'camera-1',
    reports: [
      report(windowStart, '2026-10-24T00:40:00.000Z', 2400, 2400),
      report('2026-10-24T00:30:00.000Z', windowEnd, 1800, 1800)
    ], windowStart, windowEnd, now
  });
  assert.equal(overlap.windowContinuity, 'overlaps_detected');
  assert.equal(overlap.assessment, 'incomplete_report_windows');
});

test('missing or truncated reports remain inconclusive', () => {
  const none = evaluateRecordingCoverageReports({
    organizationId: 'org-1', siteId: 'site-1', cameraId: 'camera-1',
    reports: [], windowStart, windowEnd, now
  });
  assert.equal(none.assessment, 'no_reports');
  assert.equal(none.interpretation, 'reported_not_independently_verified');

  const truncated = evaluateRecordingCoverageReports({
    organizationId: 'org-1', siteId: 'site-1', cameraId: 'camera-1',
    reports: [report(windowStart, windowEnd, 3600, 3600)], reportsTruncated: true,
    windowStart, windowEnd, now
  });
  assert.equal(truncated.windowContinuity, 'report_limit_reached');
  assert.equal(truncated.assessment, 'incomplete_report_windows');
});
