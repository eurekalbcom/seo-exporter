import { db } from "@/lib/db";
import { visibleIssueFilter } from "@/lib/crawler/issue-filter";
import { renderPrometheus, type MetricSample } from "@/lib/metrics";

type CountRow = { domain: string; value: number };
type VitalRow = { domain: string; lcp: number | null; inp: number | null; cls: number | null; ttfb: number | null };
type RecommendationRow = { domain: string; status: string; category: string; value: number };

function num(value: number | bigint | null): number {
  if (value === null) return 0;
  return typeof value === "bigint" ? Number(value) : value;
}

async function searchSamples(): Promise<MetricSample[]> {
  // Page rows are the site total. Keyword rows omit anonymised queries, and a
  // raw average of per-row positions is not the impression-weighted position.
  const rows = await db.$queryRaw<CountRow[]>`
    SELECT s.domain AS domain,
           COALESCE(SUM(p.clicks), 0)::float AS clicks,
           COALESCE(SUM(p.impressions), 0)::float AS impressions,
           CASE
             WHEN COALESCE(SUM(GREATEST(p.impressions, 0)), 0) = 0
               THEN COALESCE(AVG(p.position), 0)
             ELSE SUM(p.position * GREATEST(p.impressions, 0)::float)
                  / SUM(GREATEST(p.impressions, 0))::float
           END::float AS position
    FROM "Site" s
    LEFT JOIN "Page" p ON p."siteId" = s.id
      AND p.date >= NOW() - INTERVAL '28 days'
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
  // The crawl screens count visible issues on the latest completed crawl only.
  const latest = await db.$queryRaw<{ id: string; domain: string }[]>`
    SELECT DISTINCT ON (c."siteId") c.id AS id, s.domain AS domain
    FROM "Crawl" c
    JOIN "Site" s ON s.id = c."siteId"
    WHERE c.status::text = 'COMPLETED'
    ORDER BY c."siteId", c."finishedAt" DESC
  `;
  if (latest.length === 0) return [];

  const domainByCrawl = new Map(latest.map((row) => [row.id, row.domain]));
  const groups = await db.crawlIssue.groupBy({
    by: ["crawlId", "severity"],
    where: {
      crawlId: { in: latest.map((row) => row.id) },
      ...visibleIssueFilter(),
    },
    _count: { _all: true },
  });

  const totals = new Map<string, Map<string, number>>();
  for (const group of groups) {
    const domain = domainByCrawl.get(group.crawlId);
    if (!domain) continue;
    const bySeverity = totals.get(domain) ?? new Map<string, number>();
    bySeverity.set(group.severity, (bySeverity.get(group.severity) ?? 0) + group._count._all);
    totals.set(domain, bySeverity);
  }

  const samples: MetricSample[] = [];
  for (const [domain, bySeverity] of totals) {
    for (const [severity, value] of bySeverity) {
      samples.push({
        name: "seo_crawl_issues",
        labels: { domain, severity, category: "crawl" },
        value,
      });
    }
  }
  return samples;
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

export async function GET() {
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
