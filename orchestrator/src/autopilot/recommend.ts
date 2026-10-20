import { hostOf, normalizeUrl, type OriginCrawl } from "./crawl";
import {
  ctrBelowExpectedPages,
  ctrBelowExpectedQueries,
  landingPageClusters,
  resolveGscThresholds,
  sitemapBlocked,
  strikingDistanceQueries,
  type GscThresholdOverrides,
} from "./gsc-rules";
import type { GscPageRow, GscQueryRow } from "./gsc-csv";
import { recommendationId } from "./recommendation-id";

export const LOW_CTR = {
  minImpressions: 100,
  maxCtr: 0.03,
  minPosition: 4,
  maxPosition: 20,
} as const;

export type RecommendationStatus = "proposed" | "approved" | "rejected";

export type Recommendation = {
  id: string;
  domain: string;
  rule: string;
  opis: string;
  uzasadnienie: string;
  dane: Record<string, unknown>;
  ryzyko: string;
  rollback: string;
  status: RecommendationStatus;
};

export type RecommendInput = {
  domain: string;
  crawl: OriginCrawl[];
  queries: GscQueryRow[];
  pages: GscPageRow[];
  thresholds?: GscThresholdOverrides;
};

const UNAPPLIED = "No change has been applied.";

export { recommendationId } from "./recommendation-id";

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

function siteFor(input: RecommendInput): OriginCrawl | undefined {
  return input.crawl.find((origin) => hostOf(origin.origin) === hostOf(`https://${input.domain}`));
}

function indexableHtml(input: RecommendInput): OriginCrawl["pages"] {
  return (siteFor(input)?.pages ?? []).filter((page) => page.status === 200 && !page.noindex && page.parsedHtml);
}

function missingTitle(input: RecommendInput): Recommendation[] {
  return indexableHtml(input)
    .filter((page) => !page.title)
    .map((page) =>
      propose(input.domain, "missing-title", page.url, {
        opis: `Add a title on ${page.url}`,
        uzasadnienie: "The HTML title is empty, so search results have nothing specific to show.",
        dane: { url: page.url, title: page.title },
        ryzyko: "A new title changes the snippet searchers see.",
        rollback: `Restore the previous title element. ${UNAPPLIED}`,
      })
    );
}

function missingMeta(input: RecommendInput): Recommendation[] {
  return indexableHtml(input)
    .filter((page) => !page.metaDescription)
    .map((page) =>
      propose(input.domain, "missing-meta-description", page.url, {
        opis: `Add a meta description on ${page.url}`,
        uzasadnienie: "The meta description is missing, so the result snippet is chosen from page text.",
        dane: { url: page.url, metaDescription: page.metaDescription },
        ryzyko: "A description that oversells the page can lower clicks after people land.",
        rollback: `Restore the previous meta description. ${UNAPPLIED}`,
      })
    );
}

function missingH1(input: RecommendInput): Recommendation[] {
  return indexableHtml(input)
    .filter((page) => page.h1.length === 0)
    .map((page) =>
      propose(input.domain, "missing-h1", page.url, {
        opis: `Add one h1 on ${page.url}`,
        uzasadnienie: "The page has no h1, so the main heading is not marked up.",
        dane: { url: page.url, h1: page.h1 },
        ryzyko: "Changing the visible heading changes the page for every visitor.",
        rollback: `Restore the previous heading. ${UNAPPLIED}`,
      })
    );
}

function multipleH1(input: RecommendInput): Recommendation[] {
  return indexableHtml(input)
    .filter((page) => page.h1.length > 1)
    .map((page) =>
      propose(input.domain, "multiple-h1", page.url, {
        opis: `Keep a single h1 on ${page.url}`,
        uzasadnienie: `The page has ${page.h1.length} h1 elements.`,
        dane: { url: page.url, h1: page.h1 },
        ryzyko: "Demoting a heading changes the outline visitors and parsers see.",
        rollback: `Restore the previous headings. ${UNAPPLIED}`,
      })
    );
}

function missingCanonical(input: RecommendInput): Recommendation[] {
  return indexableHtml(input)
    .filter((page) => !page.canonical)
    .map((page) =>
      propose(input.domain, "missing-canonical", page.url, {
        opis: `Add a canonical link on ${page.url}`,
        uzasadnienie: "The page does not declare a canonical URL.",
        dane: { url: page.url, canonical: page.canonical },
        ryzyko: "A wrong canonical can drop the URL from search results.",
        rollback: `Remove the new canonical or restore the previous one. ${UNAPPLIED}`,
      })
    );
}

function noindex(input: RecommendInput): Recommendation[] {
  return (siteFor(input)?.pages ?? [])
    .filter((page) => page.status === 200 && page.noindex)
    .map((page) =>
      propose(input.domain, "noindex", page.url, {
        opis: `Remove noindex from ${page.url}`,
        uzasadnienie: "The page asks crawlers not to index it.",
        dane: { url: page.url, noindex: true },
        ryzyko: "Removing noindex can make the URL eligible for search results.",
        rollback: `Put the noindex robots directive back. ${UNAPPLIED}`,
      })
    );
}

function brokenLinks(input: RecommendInput): Recommendation[] {
  return (siteFor(input)?.brokenLinks ?? []).map((link) =>
    propose(input.domain, "broken-link", `${link.from} -> ${link.to}`, {
      opis: `Fix the broken link from ${link.from} to ${link.to}`,
      uzasadnienie: `${link.to} responded with HTTP ${link.status}.`,
      dane: { from: link.from, to: link.to, status: link.status },
      ryzyko: "Replacing the link sends visitors to a different URL.",
      rollback: `Point the link back at ${link.to}. ${UNAPPLIED}`,
    })
  );
}

function redirects(input: RecommendInput): Recommendation[] {
  return (siteFor(input)?.redirects ?? []).map((hop) =>
    propose(input.domain, "redirect", `${hop.from} -> ${hop.to}`, {
      opis: `Replace the redirect from ${hop.from} to ${hop.to} with a direct URL`,
      uzasadnienie: `The crawler followed HTTP ${hop.status} from ${hop.from} to ${hop.to}.`,
      dane: { from: hop.from, to: hop.to, status: hop.status },
      ryzyko: "Removing a redirect breaks visitors and tools that still use the old URL.",
      rollback: `Restore the HTTP ${hop.status} redirect from ${hop.from} to ${hop.to}. ${UNAPPLIED}`,
    })
  );
}

function sitemapGaps(input: RecommendInput): Recommendation[] {
  const site = siteFor(input);
  if (!site) return [];
  return site.sitemapUrls
    .filter((loc) => !sitemapResolves(site, loc))
    .map((loc) => {
      const page = site.pages.find((item) => item.url === normalizeUrl(loc));
      return propose(input.domain, "sitemap-not-ok", loc, {
        opis: `Return HTTP 200 for sitemap URL ${loc}`,
        uzasadnienie: "The sitemap lists this URL, and the crawl did not finish on HTTP 200.",
        dane: { url: loc, status: page?.status ?? null },
        ryzyko: "Changing the sitemap or the URL can remove a URL search engines already know.",
        rollback: `Restore the previous sitemap entry and the previous response. ${UNAPPLIED}`,
      });
    });
}

function sitemapResolves(site: OriginCrawl, loc: string): boolean {
  const start = normalizeUrl(loc);
  if (site.blockedByRobots.includes(start)) return true;
  let current = start;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const hop = site.redirects.find((item) => item.from === current);
    if (!hop) break;
    try {
      current = normalizeUrl(hop.to);
    } catch {
      return false;
    }
  }
  if (site.blockedByRobots.includes(current)) return true;
  const page = site.pages.find((item) => item.url === current);
  if (page) return page.status === 200;
  if (!site.requests.some((item) => item.url === start)) return true;
  return false;
}

function inCtrBand(row: { impressions: number; ctr: number; position: number }): boolean {
  return (
    row.impressions >= LOW_CTR.minImpressions &&
    row.ctr < LOW_CTR.maxCtr &&
    row.position >= LOW_CTR.minPosition &&
    row.position <= LOW_CTR.maxPosition
  );
}

function lowCtrQueries(input: RecommendInput): Recommendation[] {
  return input.queries.filter(inCtrBand).map((row) =>
    propose(input.domain, "low-ctr-query", row.query, {
      opis: `Rewrite the title and description for the query "${row.query}"`,
      uzasadnienie: `The query has ${row.impressions} impressions, CTR ${formatPct(row.ctr)}, and average position ${row.position}.`,
      dane: { query: row.query, clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position },
      ryzyko: "A snippet change can lower clicks if the new text matches the query worse.",
      rollback: `Restore the previous title and meta description. ${UNAPPLIED}`,
    })
  );
}

function lowCtrPages(input: RecommendInput): Recommendation[] {
  return input.pages.filter(inCtrBand).map((row) =>
    propose(input.domain, "low-ctr-page", row.page, {
      opis: `Rewrite the title and description for ${row.page}`,
      uzasadnienie: `The page has ${row.impressions} impressions, CTR ${formatPct(row.ctr)}, and average position ${row.position}.`,
      dane: { page: row.page, clicks: row.clicks, impressions: row.impressions, ctr: row.ctr, position: row.position },
      ryzyko: "A snippet change can lower clicks if the new text matches the query worse.",
      rollback: `Restore the previous title and meta description. ${UNAPPLIED}`,
    })
  );
}

export function recommend(input: RecommendInput): Recommendation[] {
  const thresholds = resolveGscThresholds(input.thresholds);
  const rules: Array<(value: RecommendInput) => Recommendation[]> = [
    missingTitle,
    missingMeta,
    missingH1,
    multipleH1,
    missingCanonical,
    noindex,
    brokenLinks,
    redirects,
    sitemapGaps,
    lowCtrQueries,
    lowCtrPages,
    (value) => strikingDistanceQueries(value, thresholds),
    (value) => ctrBelowExpectedQueries(value, thresholds),
    (value) => ctrBelowExpectedPages(value, thresholds),
    (value) => landingPageClusters(value, thresholds),
    sitemapBlocked,
  ];
  const byId = new Map<string, Recommendation>();
  for (const rule of rules) {
    for (const row of rule(input)) {
      if (!byId.has(row.id)) byId.set(row.id, row);
    }
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}
