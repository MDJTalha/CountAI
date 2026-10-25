const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function fail(code) { return Object.assign(new Error(code), { code }); }

export function validateRecordingAssuranceQuery({ siteId, cameraId, windowStart, windowEnd, maxReportAgeMinutes }, now = new Date()) {
  const errors = [];
  if (typeof siteId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(siteId)) errors.push('site_id_required');
  if (typeof cameraId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(cameraId)) errors.push('camera_id_required');
  const start = typeof windowStart === 'string' ? Date.parse(windowStart) : NaN;
  const end = typeof windowEnd === 'string' ? Date.parse(windowEnd) : NaN;
  if (!Number.isFinite(start)) errors.push('invalid_window_start');
  if (!Number.isFinite(end)) errors.push('invalid_window_end');
  if (Number.isFinite(start) && Number.isFinite(end)) {
    if (end <= start) errors.push('window_end_must_follow_start');
    if (end - start > MAX_WINDOW_MS) errors.push('window_exceeds_seven_days');
    if (end > now.getTime() + 5 * 60 * 1000) errors.push('window_end_too_far_in_future');
  }
  if (maxReportAgeMinutes !== undefined &&
      (!Number.isInteger(maxReportAgeMinutes) || maxReportAgeMinutes < 1 || maxReportAgeMinutes > 1440)) {
    errors.push('max_report_age_minutes_must_be_1_to_1440');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Evaluate only the completeness and arithmetic consistency of connector-signed
 * coverage reports. The result deliberately remains "reported", not verified
 * evidence of actual recording.
 */
export function evaluateRecordingCoverageReports({
  organizationId, siteId, cameraId, reports, reportsTruncated = false,
  windowStart, windowEnd, now = new Date(), maxReportAgeMinutes = 10
}) {
  const start = Date.parse(windowStart);
  const end = Date.parse(windowEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !Array.isArray(reports)) {
    throw fail('invalid_recording_assurance_query');
  }
  const relevant = reports
    .filter(report => {
      const payload = report?.payload;
      if (!payload || typeof payload !== 'object') return false;
      const reportStart = Date.parse(payload.windowStart);
      const reportEnd = Date.parse(payload.windowEnd);
      return Number.isFinite(reportStart) && Number.isFinite(reportEnd) &&
        reportEnd > start && reportStart < end;
    })
    .map(report => ({
      ...report,
      reportStart: Date.parse(report.payload.windowStart),
      reportEnd: Date.parse(report.payload.windowEnd)
    }))
    .sort((a, b) => a.reportStart - b.reportStart || a.reportEnd - b.reportEnd);

  const full = relevant.filter(report => report.reportStart >= start && report.reportEnd <= end);
  const partialReportCount = relevant.length - full.length;
  // A signed report is still untrusted input for arithmetic purposes. Reject impossible
  // counters rather than allowing negative or over-expected values to inflate coverage.
  const invalidMetricReports = full.filter(report => {
    const expected = report.payload.expectedSeconds;
    const recorded = report.payload.recordedSeconds;
    return !Number.isSafeInteger(expected) || expected <= 0 ||
      !Number.isSafeInteger(recorded) || recorded < 0 || recorded > expected;
  });
  const validMetricReports = full.filter(report => !invalidMetricReports.includes(report));
  const expectedTotal = validMetricReports.reduce((sum, report) => sum + report.payload.expectedSeconds, 0);
  const recordedTotal = validMetricReports.reduce((sum, report) => sum + report.payload.recordedSeconds, 0);
  // Individually safe integers can still overflow when summed across many reports.
  const aggregateMetricsSafe = Number.isSafeInteger(expectedTotal) &&
    Number.isSafeInteger(recordedTotal) && recordedTotal <= expectedTotal;
  let hasGap = false;
  let hasOverlap = false;
  for (let index = 1; index < full.length; index += 1) {
    if (full[index].reportStart > full[index - 1].reportEnd) hasGap = true;
    if (full[index].reportStart < full[index - 1].reportEnd) hasOverlap = true;
  }
  // Overlapping windows can double-count the same time interval. Keep the
  // assessment inconclusive and suppress aggregate metrics instead of showing
  // totals or percentages that appear more precise than the source evidence.
  const aggregateMetricsUsable = aggregateMetricsSafe && !hasOverlap;
  const expectedReportedSeconds = aggregateMetricsUsable ? expectedTotal : null;
  const recordedReportedSeconds = aggregateMetricsUsable ? recordedTotal : null;
  const reportedGapSeconds = aggregateMetricsUsable ? Math.max(0, expectedTotal - recordedTotal) : null;
  const reportedCoveragePercent = aggregateMetricsUsable && expectedTotal > 0
    ? Math.round((recordedTotal / expectedTotal) * 10000) / 100
    : null;
  const boundaryGap = full.length > 0 && (full[0].reportStart > start || full[full.length - 1].reportEnd < end);
  let windowContinuity = 'complete';
  if (reportsTruncated) windowContinuity = 'report_limit_reached';
  else if (relevant.length === 0) windowContinuity = 'no_reports';
  else if (invalidMetricReports.length > 0 || !aggregateMetricsSafe) windowContinuity = 'inconsistent_report_metrics';
  else if (hasOverlap) windowContinuity = 'overlaps_detected';
  else if (hasGap || boundaryGap) windowContinuity = 'gaps_detected';
  else if (partialReportCount > 0) windowContinuity = 'partial_windows_excluded';

  const latest = [...relevant].sort((a, b) => Date.parse(b.receivedAt || 0) - Date.parse(a.receivedAt || 0))[0];
  const latestReceiptTime = latest ? Date.parse(latest.receivedAt) : NaN;
  const latestReceiptAgeSeconds = Number.isFinite(latestReceiptTime)
    ? Math.max(0, Math.floor((now.getTime() - latestReceiptTime) / 1000))
    : null;
  const latestReportFresh = latestReceiptAgeSeconds !== null &&
    latestReceiptAgeSeconds <= maxReportAgeMinutes * 60;

  let assessment = 'no_reports';
  if (reportsTruncated) assessment = 'incomplete_report_windows';
  else if (invalidMetricReports.length > 0 || !aggregateMetricsSafe) assessment = 'inconsistent_report_data';
  else if (full.length > 0 && expectedReportedSeconds > 0) {
    assessment = windowContinuity === 'complete'
      ? (reportedCoveragePercent >= 99.5 ? 'reported_coverage_high' : 'reported_coverage_gap')
      : 'incomplete_report_windows';
  } else if (relevant.length > 0) {
    assessment = 'insufficient_report_data';
  }

  return {
    contractVersion: 1,
    organizationId: organizationId ?? null,
    siteId: siteId ?? null,
    cameraId: cameraId ?? null,
    requestedWindow: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
    reportCount: relevant.length,
    evaluatedReportCount: validMetricReports.length,
    invalidMetricReportCount: invalidMetricReports.length,
    aggregateMetricsSafe,
    partialReportCount,
    expectedReportedSeconds,
    recordedReportedSeconds,
    reportedGapSeconds,
    reportedCoveragePercent,
    windowContinuity,
    assessment,
    latestReceiptAt: latest?.receivedAt ?? null,
    latestReceiptAgeSeconds,
    latestReportFresh,
    trustLevel: 'connector-signed-report',
    interpretation: 'reported_not_independently_verified'
  };
}
