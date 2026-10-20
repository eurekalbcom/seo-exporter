import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OriginCrawl } from "./crawl";
import type { GscPageRow, GscQueryRow } from "./gsc-csv";
import { foldStatus, type Decision } from "./approval";
import type { Recommendation, RecommendationStatus } from "./recommend";

export type ReportMode = "fixture" | "live";

export type AutopilotReport = {
  generatedAt: string;
  domain: string;
  mode: ReportMode;
  recommendations: Recommendation[];
  crawl: OriginCrawl[];
  queries: GscQueryRow[];
  pages: GscPageRow[];
};

const STATUSES: readonly RecommendationStatus[] = ["proposed", "approved", "rejected"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Report recommendation is missing ${key}`);
  }
  return value;
}

export function withDecisions(report: AutopilotReport, decisions: Decision[]): AutopilotReport {
  return {
    ...report,
    recommendations: report.recommendations.map((item) => ({
      ...item,
      status: foldStatus(
        item.status,
        decisions.filter((decision) => decision.id === item.id)
      ),
    })),
  };
}

export function renderMarkdown(report: AutopilotReport): string {
  const lines = [
    "# SEO Autopilot report",
    "",
    `Domain: ${report.domain}`,
    `Generated: ${report.generatedAt}`,
    `Mode: ${report.mode}`,
    `Recommendations: ${report.recommendations.length}`,
    "",
    "Each recommendation starts as proposed. Approve or reject it in the decision log.",
    "This tool does not change the site or Search Console.",
    "",
  ];
  for (const item of report.recommendations) {
    lines.push(`## ${item.id}`, "");
    lines.push(`- status: ${item.status}`);
    lines.push(`- opis: ${item.opis}`);
    lines.push(`- uzasadnienie: ${item.uzasadnienie}`);
    lines.push(`- ryzyko: ${item.ryzyko}`);
    lines.push(`- rollback: ${item.rollback}`);
    lines.push("- dane:", "", "```json", JSON.stringify(item.dane, null, 2), "```", "");
  }
  return lines.join("\n");
}

export function reportJson(report: AutopilotReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function writeReport(dir: string, report: AutopilotReport): { jsonPath: string; markdownPath: string } {
  mkdirSync(dir, { recursive: true });
  const jsonPath = join(dir, "report.json");
  const markdownPath = join(dir, "report.md");
  writeFileSync(jsonPath, reportJson(report));
  writeFileSync(markdownPath, renderMarkdown(report));
  return { jsonPath, markdownPath };
}

export function readReport(path: string): AutopilotReport {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(value)) throw new Error("Report JSON must be an object");
  if (typeof value.generatedAt !== "string" || typeof value.domain !== "string") {
    throw new Error("Report JSON is missing domain or generatedAt");
  }
  if (value.mode !== "fixture" && value.mode !== "live") throw new Error("Report JSON has an unknown mode");
  if (!Array.isArray(value.recommendations)) throw new Error("Report JSON is missing recommendations");
  const recommendations: Recommendation[] = value.recommendations.map((item) => {
    if (!isRecord(item)) throw new Error("Report recommendation must be an object");
    const status = item.status;
    if (typeof status !== "string" || !STATUSES.includes(status as RecommendationStatus)) {
      throw new Error("Report recommendation has an unknown status");
    }
    if (!isRecord(item.dane)) throw new Error("Report recommendation is missing dane");
    return {
      id: requireString(item, "id"),
      domain: requireString(item, "domain"),
      rule: requireString(item, "rule"),
      opis: requireString(item, "opis"),
      uzasadnienie: requireString(item, "uzasadnienie"),
      dane: item.dane,
      ryzyko: requireString(item, "ryzyko"),
      rollback: requireString(item, "rollback"),
      status: status as RecommendationStatus,
    };
  });
  return {
    generatedAt: value.generatedAt,
    domain: value.domain,
    mode: value.mode,
    recommendations,
    crawl: Array.isArray(value.crawl) ? (value.crawl as OriginCrawl[]) : [],
    queries: Array.isArray(value.queries) ? (value.queries as GscQueryRow[]) : [],
    pages: Array.isArray(value.pages) ? (value.pages as GscPageRow[]) : [],
  };
}
