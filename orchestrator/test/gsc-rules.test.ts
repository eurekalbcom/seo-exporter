import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { OriginCrawl } from "../src/autopilot/crawl";
import { parseGscPages, parseGscQueries } from "../src/autopilot/gsc-csv";
import { expectedCtr } from "../src/autopilot/gsc-rules";
import { recommend } from "../src/autopilot/recommend";

const FIXTURE = join(import.meta.dirname, "../fixtures/autopilot");

function crawl(status = 403, extraPage?: string): OriginCrawl[] {
  const pages: OriginCrawl["pages"] = [
    {
      url: "https://bezkolejki.org/",
      status: 200,
      contentType: "text/html",
      title: "Kolejki NFZ – wolne terminy u lekarza | BezKolejki.org",
      metaDescription: "Terminy NFZ",
      canonical: "https://bezkolejki.org/",
      h1: ["Znajdź najszybszy termin wizyty na NFZ"],
      noindex: false,
      links: [],
      parsedHtml: true,
    },
  ];
  if (extraPage) {
    pages.push({
      url: extraPage,
      status: 200,
      contentType: "text/html",
      title: "Lekarz",
      metaDescription: null,
      canonical: extraPage,
      h1: ["Lekarz bez kolejki"],
      noindex: false,
      links: [],
      parsedHtml: true,
    });
  }
  return [
    {
      origin: "https://bezkolejki.org",
      robotsStatus: 200,
      robotsOutcome: "rules",
      crawlDelaySeconds: null,
      sitemapUrls: [],
      pages,
      redirects: [],
      blockedByRobots: [],
      brokenLinks: [],
      skippedOffHost: [],
      requests: [
        { url: "https://bezkolejki.org/robots.txt", method: "GET", status: 200 },
        { url: "https://bezkolejki.org/sitemap.xml", method: "GET", status },
        { url: "https://bezkolejki.org/", method: "GET", status: 200 },
      ],
    },
  ];
}

function rows(options?: { status?: number; extraPage?: string; thresholds?: Parameters<typeof recommend>[0]["thresholds"] }) {
  return recommend({
    domain: "bezkolejki.org",
    crawl: crawl(options?.status ?? 403, options?.extraPage),
    queries: parseGscQueries(readFileSync(join(FIXTURE, "gsc-bezkolejki-queries.csv"), "utf8")),
    pages: parseGscPages(readFileSync(join(FIXTURE, "gsc-bezkolejki-pages.csv"), "utf8")),
    thresholds: options?.thresholds,
  });
}

describe("GSC opportunity rules", () => {
  it("reads striking distance, expected CTR, unmatched clusters, and a blocked sitemap from the fixture CSV", () => {
    const found = rows();
    const striking = found.filter((row) => row.rule === "striking-distance-query");
    expect(striking.map((row) => row.dane.query).sort()).toEqual(["bez kolejki nfz", "bezkolejki nfz", "lekarz bez kolejki"]);
    expect(striking.find((row) => row.dane.query === "bez kolejki nfz")?.dane).toMatchObject({
      impressions: 68,
      position: 8.9,
      page: "https://bezkolejki.org/",
    });
    for (const row of striking) {
      expect(row.opis).toMatch(/title, h1/);
      expect(row.rollback).toMatch(/No change has been applied/);
    }

    const ctr = found.filter((row) => row.rule === "ctr-below-expected-query");
    expect(ctr.map((row) => row.dane.query)).toEqual(["lekarz bez kolejki"]);
    expect(ctr[0]?.dane).toMatchObject({ ctr: 0, impressions: 23, expectedCtr: expectedCtr(18.3) });
    expect(found.some((row) => row.rule === "ctr-below-expected-page")).toBe(false);

    const clusters = found.filter((row) => row.rule === "landing-page-cluster");
    expect(clusters.map((row) => row.dane.cluster).sort()).toEqual(["kraków", "lekarz"]);
    expect(clusters.find((row) => row.dane.cluster === "lekarz")?.dane).toMatchObject({ impressions: 41 });
    expect(clusters.find((row) => row.dane.cluster === "kraków")?.dane.queries).toEqual([
      expect.objectContaining({ query: "kolejka nfz kraków", impressions: 1 }),
      expect.objectContaining({ query: "kolejki nfz kraków", impressions: 1 }),
    ]);
    const clustered = clusters.flatMap((row) => (row.dane.queries as Array<{ query: string }>).map((item) => item.query));
    expect(clustered).not.toContain("bez kolejki nfz");
    expect(clustered).not.toContain("bezkolejki");

    const sitemap = found.find((row) => row.rule === "sitemap-blocked");
    expect(sitemap?.dane).toMatchObject({ url: "https://bezkolejki.org/sitemap.xml", status: 403, bypass: false });
    expect(sitemap?.opis).toMatch(/Googlebot/);
    expect(sitemap?.uzasadnienie).toMatch(/Do not bypass the WAF/);
    expect(`${sitemap?.opis} ${sitemap?.uzasadnienie}`).not.toMatch(/user-agent|curl|disable the waf/i);
  });

  it("drops a cluster when a page path and h1 already match it, and honors higher thresholds", () => {
    const covered = rows({ extraPage: "https://bezkolejki.org/lekarz" });
    expect(covered.filter((row) => row.rule === "landing-page-cluster").map((row) => row.dane.cluster)).toEqual(["kraków"]);

    const stricter = rows({
      thresholds: {
        strikingDistance: { minImpressions: 50 },
        ctrVsExpected: { minImpressions: 24 },
        landingCluster: { minImpressions: 10 },
      },
    });
    expect(stricter.filter((row) => row.rule === "striking-distance-query").map((row) => row.dane.query).sort()).toEqual([
      "bez kolejki nfz",
      "bezkolejki nfz",
    ]);
    expect(stricter.some((row) => row.rule === "ctr-below-expected-query")).toBe(false);
    expect(stricter.filter((row) => row.rule === "landing-page-cluster").map((row) => row.dane.cluster)).toEqual(["lekarz"]);
  });

  it("does not flag a sitemap that returned HTTP 200", () => {
    expect(rows({ status: 200 }).some((row) => row.rule === "sitemap-blocked")).toBe(false);
  });

  it("keeps striking distance and expected CTR closed at the threshold edges", () => {
    const band = (impressions: number, ctr: number, position: number) =>
      new Set(
        recommend({
          domain: "bezkolejki.org",
          crawl: [],
          queries: [{ query: "edge case", clicks: 0, impressions, ctr, position }],
          pages: [],
        }).map((row) => row.rule)
      );
    expect(band(10, 0.2, 4).has("striking-distance-query")).toBe(true);
    expect(band(9, 0.2, 4).has("striking-distance-query")).toBe(false);
    expect(band(10, 0.2, 3.9).has("striking-distance-query")).toBe(false);
    expect(band(10, 0.2, 20).has("striking-distance-query")).toBe(true);
    expect(band(10, 0.2, 20.1).has("striking-distance-query")).toBe(false);
    expect(expectedCtr(4)).toBe(0.08);
    expect(band(20, 0.039, 4).has("ctr-below-expected-query")).toBe(true);
    expect(band(20, 0.04, 4).has("ctr-below-expected-query")).toBe(false);
    expect(band(19, 0, 4).has("ctr-below-expected-query")).toBe(false);
    expect(band(100, 0, 20.6).has("ctr-below-expected-query")).toBe(false);
  });
});
