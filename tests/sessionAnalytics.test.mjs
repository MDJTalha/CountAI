import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizePhotoSessions } from '../src/engine/sessionAnalytics.mjs';
const session = (id, createdAt, detections, mode = 'photo') => ({ id, createdAt, title: id, mode, target: 'all objects', detections, totals: {} });

test('summarizes photo sessions, categories and manual corrections in the selected window', () => {
  const now = Date.parse('2026-10-24T12:00:00.000Z');
  const sessions = [
    session('today', '2026-10-24T08:00:00.000Z', [{category:'person',source:'local'},{category:'person',source:'manual'},{category:'bottle',source:'local'}]),
    session('yesterday', '2026-10-23T08:00:00.000Z', [{category:'bottle',source:'manual'}]),
    session('old', '2026-09-01T08:00:00.000Z', [{category:'car',source:'local'}]),
    session('live', '2026-10-24T09:00:00.000Z', [{category:'person',source:'local'}], 'live')
  ];
  const summary = summarizePhotoSessions(sessions, {now, days:7});
  assert.equal(summary.totalSessions, 2);
  assert.equal(summary.totalDetections, 4);
  assert.equal(summary.manualCorrections, 2);
  assert.equal(summary.averageDetections, 2);
  assert.deepEqual(summary.categories, [{category:'bottle',count:2},{category:'person',count:2}]);
  assert.equal(summary.dailyTrend.length, 7);
  assert.equal(summary.dailyTrend.at(-1).detections, 3);
});
test('all-time summary includes valid photo sessions and safely ignores malformed dates', () => {
  const sessions = [session('one','2026-01-01T00:00:00.000Z',[{category:'car',source:'local'}]),session('bad-date','not-a-date',[{category:'person',source:'local'}])];
  const summary = summarizePhotoSessions(sessions,{now:Date.parse('2026-10-24T12:00:00.000Z'),days:0});
  assert.equal(summary.totalSessions,1); assert.equal(summary.totalDetections,1);
  assert.deepEqual(summary.dailyTrend,[{date:'2026-01-01',sessions:1,detections:1}]);
});
test('empty history returns zero-safe metrics and a dated trend', () => {
  const summary = summarizePhotoSessions([],{now:Date.parse('2026-10-24T12:00:00.000Z'),days:3});
  assert.equal(summary.totalSessions,0); assert.equal(summary.averageDetections,0);
  assert.equal(summary.categories.length,0); assert.deepEqual(summary.dailyTrend.map(day=>day.detections),[0,0,0]);
});
