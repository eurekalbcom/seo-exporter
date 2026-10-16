/**
 * Quick-win score. Effort is the cost (higher = harder).
 * score = impact / effort, which is impact × (1 / effort).
 * A higher score is a better quick win.
 */
export function quickWinScore(impact: number, effort: number): number {
  if (!Number.isFinite(impact) || !Number.isFinite(effort) || impact < 0 || effort <= 0) return 0;
  return impact / effort;
}
