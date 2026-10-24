const DAY_MS = 24 * 60 * 60 * 1000;
function validDate(value) { const time = Date.parse(value); return Number.isFinite(time) ? time : null; }

/** Summarize saved photo sessions; live crossings are excluded until persisted in the session schema. */
export function summarizePhotoSessions(sessions, { now = Date.now(), days = 7 } = {}) {
  const photos = (Array.isArray(sessions) ? sessions : [])
    .filter(session => session?.mode === 'photo' && validDate(session.createdAt) !== null)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const start = Number.isFinite(days) && days > 0 ? now - days * DAY_MS : -Infinity;
  const selected = photos.filter(session => Date.parse(session.createdAt) >= start && Date.parse(session.createdAt) <= now);
  const categoryTotals = {};
  const daily = new Map();
  let totalDetections = 0;
  let manualCorrections = 0;
  for (const session of selected) {
    const detections = Array.isArray(session.detections) ? session.detections : [];
    totalDetections += detections.length;
    manualCorrections += detections.filter(detection => detection?.source === 'manual').length;
    const date = new Date(Date.parse(session.createdAt)).toISOString().slice(0, 10);
    const day = daily.get(date) ?? { date, sessions: 0, detections: 0 };
    day.sessions += 1; day.detections += detections.length; daily.set(date, day);
    for (const detection of detections) {
      const category = typeof detection?.category === 'string' && detection.category.trim() ? detection.category.trim() : 'unknown';
      categoryTotals[category] = (categoryTotals[category] ?? 0) + 1;
    }
  }
  const daysToShow = Number.isFinite(days) && days > 0 ? Math.min(Math.ceil(days), 90) : 0;
  const dailyTrend = [];
  if (daysToShow) {
    const today = new Date(now);
    const utcToday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    for (let offset = daysToShow - 1; offset >= 0; offset -= 1) {
      const date = new Date(utcToday - offset * DAY_MS).toISOString().slice(0, 10);
      dailyTrend.push(daily.get(date) ?? { date, sessions: 0, detections: 0 });
    }
  } else dailyTrend.push(...[...daily.values()].sort((a, b) => a.date.localeCompare(b.date)));
  return {
    totalSessions: selected.length, totalDetections, manualCorrections,
    averageDetections: selected.length ? Math.round((totalDetections / selected.length) * 10) / 10 : 0,
    categories: Object.entries(categoryTotals).map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count || a.category.localeCompare(b.category)),
    dailyTrend,
    recentSessions: selected.slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 8)
  };
}
