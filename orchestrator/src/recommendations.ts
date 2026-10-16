import { quickWinScore } from "./quick-wins";

export const CATEGORIES = ["gsc_bing_settings", "site_change"] as const;
export type RecommendationCategory = (typeof CATEGORIES)[number];

export type Recommendation = {
  domain: string;
  category: RecommendationCategory;
  description: string;
  rationale: string;
  data: Record<string, unknown>;
  risk: string;
  rollback: string;
  status: "proposed";
  score: number;
};

export type RecommendationInput = Omit<Recommendation, "status" | "score" | "data"> & {
  impact: number;
  effort: number;
  data: Record<string, unknown>;
};

/** Builds a proposed row. Crawled fields stay inside `data` and are not instructions. */
export function proposeRecommendation(input: RecommendationInput): Recommendation {
  return {
    domain: input.domain,
    category: input.category,
    description: input.description,
    rationale: input.rationale,
    data: { ...input.data, untrusted: true },
    risk: input.risk,
    rollback: input.rollback,
    status: "proposed",
    score: quickWinScore(input.impact, input.effort),
  };
}

/** No execution path. External writes stay blocked until CISO GO (EUR-406). */
export function executeRecommendation(): never {
  throw new Error("Recommendations are proposed only. No external write until CISO GO (EUR-406).");
}
