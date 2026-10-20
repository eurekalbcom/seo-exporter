import { hostOf, type OriginCrawl } from "./crawl";
import { escapeMarkdownInline } from "./markdown-text";
import type { GscPageRow, GscQueryRow } from "./gsc-csv";
import { recommendationId } from "./recommendation-id";
import type { RecommendInput, Recommendation } from "./recommend";

/** Organic CTR by rounded position. Search Console does not send this column. */
export const EXPECTED_CTR_BY_POSITION: readonly number[] = [
  0, 0.28, 0.15, 0.11, 0.08, 0.06, 0.04, 0.03, 0.025, 0.02, 0.015, 0.012, 0.011, 0.01, 0.009, 0.008, 0.007,
  0.006, 0.005, 0.004, 0.004,
];

export const DEFAULT_GSC_THRESHOLDS = {
  strikingDistance: { minPosition: 4, maxPosition: 20, minImpressions: 10 },
  ctrVsExpected: { minImpressions: 20, maxCtrRatio: 0.5 },
  landingCluster: { minImpressions: 1, genericStemShare: 0.4 },
} as const;

export type GscThresholds = {
  strikingDistance: { minPosition: number; maxPosition: number; minImpressions: number };
  ctrVsExpected: { minImpressions: number; maxCtrRatio: number; curve: readonly number[] };
  landingCluster: { minImpressions: number; genericStemShare: number };
};

export type GscThresholdOverrides = {
  strikingDistance?: Partial<GscThresholds["strikingDistance"]>;
  ctrVsExpected?: Partial<GscThresholds["ctrVsExpected"]>;
  landingCluster?: Partial<GscThresholds["landingCluster"]>;
};

const UNAPPLIED = "No change has been applied.";
const STOP = new Set(["bez", "pl", "www", "http", "https", "html", "oraz", "albo"]);

export function resolveGscThresholds(overrides?: GscThresholdOverrides): GscThresholds {
  return {
    strikingDistance: { ...DEFAULT_GSC_THRESHOLDS.strikingDistance, ...overrides?.strikingDistance },
    ctrVsExpected: {
      minImpressions: overrides?.ctrVsExpected?.minImpressions ?? DEFAULT_GSC_THRESHOLDS.ctrVsExpected.minImpressions,
      maxCtrRatio: overrides?.ctrVsExpected?.maxCtrRatio ?? DEFAULT_GSC_THRESHOLDS.ctrVsExpected.maxCtrRatio,
      curve: overrides?.ctrVsExpected?.curve ?? EXPECTED_CTR_BY_POSITION,
    },
    landingCluster: { ...DEFAULT_GSC_THRESHOLDS.landingCluster, ...overrides?.landingCluster },
  };
}

export function expectedCtr(position: number, curve: readonly number[] = EXPECTED_CTR_BY_POSITION): number | null {
  if (!Number.isFinite(position)) return null;
  const rounded = Math.round(position);
  if (rounded < 1 || rounded >= curve.length) return null;
  const value = curve[rounded];
  return value === undefined ? null : value;
}

function propose(
  domain: string,
  rule: string,
  subject: string,
  fields: Pick<Recommendation, "opis" | "uzasadnienie" | "dane" | "ryzyko" | "rollback">
): Recommendation {
  return {
    id: recommendationId(domain, rule, subject),
    domain,
    rule,
    status: "proposed",
    ...fields,
  };
}

function formatPct(ctr: number): string {
  return `${(ctr * 100).toFixed(1)}%`;
}

function fold(value: string): string {
  return value.toLowerCase().replace(/ł/g, "l").normalize("NFD").replace(/\p{M}/gu, "");
}

function tokens(value: string): string[] {
  return fold(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4 && !STOP.has(token));
}

function stem(token: string): string {
  return token.slice(0, 6);
}

function stemsOf(value: string): string[] {
  return [...new Set(tokens(value).map(stem))];
}

function siteOf(input: RecommendInput): OriginCrawl | undefined {
  return input.crawl.find((origin) => hostOf(origin.origin) === hostOf(`https://${input.domain}`));
}

function brandStems(domain: string): Set<string> {
  const host = hostOf(`https://${domain}`);
  const label = host.split(".")[0] ?? "";
  const branded = stem(fold(label));
  return branded.length >= 4 ? new Set([branded]) : new Set();
}

type KnownPage = { url: string; title: string | null; h1: string[]; path: string };

function knownPages(input: RecommendInput): KnownPage[] {
  const site = siteOf(input);
  const crawled = (site?.pages ?? [])
    .filter((page) => page.status === 200 && !page.noindex)
    .map((page) => ({ url: page.url, title: page.title, h1: page.h1, path: pathOf(page.url) }));
  const exported = input.pages.map((row) => ({ url: row.page, title: null, h1: [] as string[], path: pathOf(row.page) }));
  const seen = new Set<string>();
  const pages: KnownPage[] = [];
  for (const page of [...crawled, ...exported]) {
    if (seen.has(page.url)) continue;
    seen.add(page.url);
    pages.push(page);
  }
  return pages;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

function pageStems(pages: KnownPage[]): Set<string> {
  const stems = new Set<string>();
  for (const page of pages) {
    for (const item of stemsOf(`${page.path} ${page.h1.join(" ")}`)) stems.add(item);
  }
  return stems;
}

function phraseCovered(query: string, pages: KnownPage[]): boolean {
  const needle = fold(query).replace(/\s+/g, " ").trim();
  if (!needle) return false;
  return pages.some((page) => fold(`${page.path} ${page.title ?? ""} ${page.h1.join(" ")}`).includes(needle));
}

function bestPage(query: string, pages: KnownPage[]): KnownPage | null {
  const stems = stemsOf(query);
  let best: KnownPage | null = null;
  let bestScore = 0;
  for (const page of pages) {
    if (!page.title && page.h1.length === 0) continue;
    const hay = fold(`${page.path} ${page.title ?? ""} ${page.h1.join(" ")}`);
    const score = stems.filter((item) => hay.includes(item)).length;
    if (score > bestScore) {
      best = page;
      bestScore = score;
    }
  }
  return best;
}

function inStrikingBand(row: { impressions: number; position: number }, thresholds: GscThresholds): boolean {
  return (
    row.impressions >= thresholds.strikingDistance.minImpressions &&
    row.position >= thresholds.strikingDistance.minPosition &&
    row.position <= thresholds.strikingDistance.maxPosition
  );
}

export function strikingDistanceQueries(input: RecommendInput, thresholds: GscThresholds): Recommendation[] {
  const pages = knownPages(input);
  return input.queries.filter((row) => inStrikingBand(row, thresholds)).map((row) => {
    const page = bestPage(row.query, pages);
    const where = page ? ` on ${escapeMarkdownInline(page.url)}` : "";
    return propose(input.domain, "striking-distance-query", row.query, {
      opis: `Suggest a title, h1, and on-page section for "${escapeMarkdownInline(row.query)}"${where}.`,
      uzasadnienie: `The query is at position ${row.position} with ${row.impressions} impressions, inside the striking-distance band.`,
      dane: {
        query: row.query,
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: row.ctr,
        position: row.position,
        page: page?.url ?? null,
        title: page?.title ?? null,
        h1: page?.h1 ?? [],
        thresholds: thresholds.strikingDistance,
      },
      ryzyko: "Changing the title, h1, or body can move rankings for other queries on the same URL.",
      rollback: `Restore the previous title, h1, and page text. ${UNAPPLIED}`,
    });
  });
}

function belowExpected(row: { impressions: number; ctr: number; position: number }, thresholds: GscThresholds): number | null {
  if (row.impressions < thresholds.ctrVsExpected.minImpressions) return null;
  const expected = expectedCtr(row.position, thresholds.ctrVsExpected.curve);
  if (expected === null) return null;
  if (!(row.ctr < expected * thresholds.ctrVsExpected.maxCtrRatio)) return null;
  return expected;
}

export function ctrBelowExpectedQueries(input: RecommendInput, thresholds: GscThresholds): Recommendation[] {
  return input.queries.flatMap((row) => {
    const expected = belowExpected(row, thresholds);
    if (expected === null) return [];
    return [
      propose(input.domain, "ctr-below-expected-query", row.query, {
        opis: `Rewrite the title and meta description for the query "${escapeMarkdownInline(row.query)}".`,
        uzasadnienie: `CTR is ${formatPct(row.ctr)} at position ${row.position}. The curve for that position is about ${formatPct(expected)}.`,
        dane: ctrDane(row, expected, thresholds),
        ryzyko: "A snippet that over-promises can earn the click and lose the visitor.",
        rollback: `Restore the previous title and meta description. ${UNAPPLIED}`,
      }),
    ];
  });
}

export function ctrBelowExpectedPages(input: RecommendInput, thresholds: GscThresholds): Recommendation[] {
  return input.pages.flatMap((row) => {
    const expected = belowExpected(row, thresholds);
    if (expected === null) return [];
    return [
      propose(input.domain, "ctr-below-expected-page", row.page, {
        opis: `Rewrite the title and meta description on ${escapeMarkdownInline(row.page)}.`,
        uzasadnienie: `CTR is ${formatPct(row.ctr)} at position ${row.position}. The curve for that position is about ${formatPct(expected)}.`,
        dane: ctrDane(row, expected, thresholds),
        ryzyko: "A snippet that over-promises can earn the click and lose the visitor.",
        rollback: `Restore the previous title and meta description. ${UNAPPLIED}`,
      }),
    ];
  });
}

function ctrDane(row: GscQueryRow | GscPageRow, expected: number, thresholds: GscThresholds): Record<string, unknown> {
  const subject = "query" in row ? { query: row.query } : { page: row.page };
  return {
    ...subject,
    clicks: row.clicks,
    impressions: row.impressions,
    ctr: row.ctr,
    position: row.position,
    expectedCtr: expected,
    maxCtrRatio: thresholds.ctrVsExpected.maxCtrRatio,
  };
}

type Cluster = { key: string; label: string; queries: GscQueryRow[] };

export function landingPageClusters(input: RecommendInput, thresholds: GscThresholds): Recommendation[] {
  const pages = knownPages(input);
  const covered = pageStems(pages);
  const branded = brandStems(input.domain);
  const frequency = new Map<string, number>();
  for (const row of input.queries) {
    for (const item of stemsOf(row.query)) frequency.set(item, (frequency.get(item) ?? 0) + 1);
  }
  const generic = genericStems(frequency, input.queries.length, thresholds.landingCluster.genericStemShare);
  const labels = new Map<string, string>();
  const groups = new Map<string, GscQueryRow[]>();
  for (const row of input.queries) {
    if (phraseCovered(row.query, pages)) continue;
    const open = stemsOf(row.query).filter((item) => !branded.has(item) && !covered.has(item) && !generic.has(item));
    if (open.length === 0) continue;
    const key = rarest(open, frequency);
    const label = shortestToken(row.query, key);
    const current = labels.get(key);
    if (!current || label.length < current.length) labels.set(key, label);
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const clusters: Cluster[] = [...groups.entries()].map(([key, queries]) => ({
    key,
    label: labels.get(key) ?? key,
    queries,
  }));
  return clusters.flatMap((cluster) => {
    const impressions = cluster.queries.reduce((sum, row) => sum + row.impressions, 0);
    if (impressions < thresholds.landingCluster.minImpressions) return [];
    const clicks = cluster.queries.reduce((sum, row) => sum + row.clicks, 0);
    const listed = [...cluster.queries].sort((left, right) => right.impressions - left.impressions || left.query.localeCompare(right.query));
    const names = listed.map((row) => `"${escapeMarkdownInline(row.query)}"`).join(", ");
    return [
      propose(input.domain, "landing-page-cluster", cluster.key, {
        opis: `Propose a new landing page for the ${escapeMarkdownInline(cluster.label)} queries: ${names}.`,
        uzasadnienie: `The cluster has ${impressions} impressions and no crawled path or h1 that matches it.`,
        dane: {
          cluster: cluster.label,
          impressions,
          clicks,
          queries: listed.map((row) => ({
            query: row.query,
            clicks: row.clicks,
            impressions: row.impressions,
            ctr: row.ctr,
            position: row.position,
          })),
          thresholds: thresholds.landingCluster,
        },
        ryzyko: "A thin new page can compete with a URL that already ranks for a related query.",
        rollback: `Leave the page unpublished and remove any internal links added for it. ${UNAPPLIED}`,
      }),
    ];
  });
}

function genericStems(frequency: Map<string, number>, total: number, share: number): Set<string> {
  const generic = new Set<string>();
  if (total <= 0) return generic;
  for (const [item, count] of frequency) {
    if (count / total >= share) generic.add(item);
  }
  // "topica" and "topics" share a five-letter prefix, so the rarer spelling stays with the head term.
  const prefixes = new Set([...generic].map((item) => item.slice(0, 5)));
  for (const item of frequency.keys()) {
    if (prefixes.has(item.slice(0, 5))) generic.add(item);
  }
  return generic;
}

function rarest(stems: string[], frequency: Map<string, number>): string {
  return [...stems].sort((left, right) => {
    const byCount = (frequency.get(left) ?? 0) - (frequency.get(right) ?? 0);
    if (byCount !== 0) return byCount;
    return right.length - left.length || left.localeCompare(right);
  })[0] ?? stems[0] ?? "";
}

function shortestToken(query: string, key: string): string {
  const folded = fold(query);
  const parts = query.split(/[^0-9A-Za-zĄąĆćĘęŁłŃńÓóŚśŹźŻż]+/).filter(Boolean);
  const matches = parts.filter((part) => stem(fold(part)) === key);
  return matches.sort((left, right) => left.length - right.length)[0] ?? folded;
}

function isSitemapUrl(url: string): boolean {
  try {
    return /sitemap[^/]*\.xml$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export function sitemapBlocked(input: RecommendInput): Recommendation[] {
  const site = siteOf(input);
  if (!site) return [];
  const statusByUrl = new Map<string, number>();
  for (const request of site.requests) {
    if (request.method !== "GET" || !isSitemapUrl(request.url)) continue;
    statusByUrl.set(request.url, request.status);
  }
  return [...statusByUrl.entries()].flatMap(([url, status]) => {
    if (status === 200) return [];
    return [
      propose(input.domain, "sitemap-blocked", url, {
        opis: `Check the WAF and bot rules for ${url}, including whether Googlebot can fetch it.`,
        uzasadnienie: `The crawl received HTTP ${status} for the sitemap. Confirm Googlebot reachability. Do not bypass the WAF or spoof a crawler.`,
        dane: { url, status, bypass: false },
        ryzyko: "Opening the sitemap to more clients can expose the URL list beyond Googlebot.",
        rollback: `Restore the previous WAF or bot rule. ${UNAPPLIED}`,
      }),
    ];
  });
}
