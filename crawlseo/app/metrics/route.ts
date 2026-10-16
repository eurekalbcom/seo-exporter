import { db } from "@/lib/db";
import { bearerMatches } from "@/lib/secret-compare";
import { renderPrometheus, type MetricSample } from "@/lib/metrics";

type CountRow = { domain: string; value: number };
type IssueRow = { domain: string; severity: string; value: number };
type VitalRow = { domain: string; lcp: number | null; inp: number | null; cls: number | null; ttfb: number | null };
type RecommendationRow = { domain: string; status: string; category: string; value: number };

function num(value: number | bigint | null): number {
  if (value === null) return 0;
  return typeof value === "bigint" ? Number(value) : value;
}

async function searchSamples(): Promise<MetricSample[]> {
  const rows = await db.$queryRaw<CountRow[]>`
    SELECT s.domain AS domain,
           COALESCE(SUM(k.clicks), 0)::float AS clicks,
           COALESCE(SUM(k.impressions), 0)::float AS impressions,
           COALESCE(AVG(k.position), 0)::float AS position
    FROM "Site" s
    LEFT JOIN "Keyword" k ON k."siteId" = s.id
      AND k.date >= NOW() - INTERVAL '28 days'
    GROUP BY s.domain
  `;
  const samples: MetricSample[] = [];
  for (const row of rows as unknown as Array<{ domain: string; clicks: number; impressions: number; position: number }>) {
    const domain = row.domain;
    samples.push(
      { name: "seo_clicks", labels: { domain, category: "gsc" }, value: num(row.clicks) },
      { name: "seo_impressions", labels: { domain, category: "gsc" }, value: num(row.impressions) },
      { name: "seo_position", labels: { domain, category: "gsc" }, value: num(row.position) },
    );
  }
  return samples;
}

async function issueSamples(): Promise<MetricSample[]> {
  const rows = await db.$queryRaw<IssueRow[]>`
    SELECT s.domain AS domain, i.severity::text AS severity, COUNT(*)::float AS value
    FROM "CrawlIssue" i
    JOIN "Crawl" c ON c.id = i."crawlId"
    JOIN "Site" s ON s.id = c."siteId"
    GROUP BY s.domain, i.severity
  `;
  return rows.map((row) => ({
    name: "seo_crawl_issues" as const,
    labels: { domain: row.domain, severity: row.severity, category: "crawl" },
    value: num(row.value),
  }));
}

async function vitalSamples(): Promise<MetricSample[]> {
  const rows = await db.$queryRaw<VitalRow[]>`
    SELECT DISTINCT ON (s.domain)
      s.domain AS domain, v.lcp, v.inp, v.cls, v.ttfb
    FROM "VitalsReport" v
    JOIN "Site" s ON s.id = v."siteId"
    ORDER BY s.domain, v.date DESC
  `;
  const samples: MetricSample[] = [];
  for (const row of rows) {
    const metrics: Array<["lcp" | "inp" | "cls" | "ttfb", number | null]> = [
      ["lcp", row.lcp],
      ["inp", row.inp],
      ["cls", row.cls],
      ["ttfb", row.ttfb],
    ];
    for (const [metric, value] of metrics) {
      if (value === null) continue;
      samples.push({
        name: "seo_cwv",
        labels: { domain: row.domain, metric, category: "vitals" },
        value,
      });
    }
  }
  return samples;
}

async function recommendationSamples(): Promise<MetricSample[]> {
  try {
    const rows = await db.$queryRaw<RecommendationRow[]>`
      SELECT domain, status, category, COUNT(*)::float AS value
      FROM recommendations
      GROUP BY domain, status, category
    `;
    return rows.map((row) => ({
      name: "seo_recommendations" as const,
      labels: { domain: row.domain, status: row.status, category: row.category },
      value: num(row.value),
    }));
  } catch {
    return [];
  }
}

export async function GET(req: Request) {
  if (!bearerMatches(req.headers.get("authorization"), process.env.METRICS_TOKEN)) {
    return new Response("unauthorized\n", { status: 401 });
  }
  try {
    const samples = [
      ...(await searchSamples()),
      ...(await issueSamples()),
      ...(await vitalSamples()),
      ...(await recommendationSamples()),
    ];
    return new Response(renderPrometheus(samples), {
      headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
    });
  } catch (error) {
    console.error("metrics error:", error);
    return new Response("metrics unavailable\n", { status: 500 });
  }
}
