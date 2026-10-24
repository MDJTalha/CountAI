import type { CountSession } from '../types/counting';
export interface PhotoAnalyticsSummary {
  totalSessions: number; totalDetections: number; manualCorrections: number; averageDetections: number;
  categories: Array<{ category: string; count: number }>;
  dailyTrend: Array<{ date: string; sessions: number; detections: number }>;
  recentSessions: CountSession[];
}
export function summarizePhotoSessions(sessions: CountSession[], options?: { now?: number; days?: number }): PhotoAnalyticsSummary;
