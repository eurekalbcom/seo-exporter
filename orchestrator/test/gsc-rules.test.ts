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
      url: "https://example.com/",
      status: 200,
      contentType: "text/html",
      title: "Sample Guide | Example",
      metaDescription: "A sample guide",
      canonical: "https://example.com/",
      h1: ["Find a sample item"],
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
      h1: ["Widget sample"],
      noindex: false,
      links: [],
      parsedHtml: true,
    });
  }
  return [
    {
      origin: "https://example.com",
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
        { url: "https://example.com/robots.txt", method: "GET", status: 200 },
        { url: "https://example.com/sitemap.xml", method: "GET", status },
        { url: "https://example.com/", method: "GET", status: 200 },
      ],
    },
  ];
}

function rows(options?: { status?: number; extraPage?: string; thresholds?: Parameters<typeof recommend>[0]["thresholds"] }) {
  return recommend({
    domain: "example.com",
    crawl: crawl(options?.status ?? 403, options?.extraPage),
    queries: parseGscQueries(readFileSync(join(FIXTURE, "gsc-opportunities-queries.csv"), "utf8")),
    pages: parseGscPages(readFileSync(join(FIXTURE, "gsc-opportunities-pages.csv"), "utf8")),
    thresholds: options?.thresholds,
  });
}

describe("GSC opportunity rules", () => {
  it("reads striking distance, expected CTR, unmatched clusters, and a blocked sitemap from the fixture CSV", () => {
    const found = rows();
    const striking = found.filter((row) => row.rule === "striking-distance-query");
    expect(striking.map((row) => row.dane.query).sort()).toEqual(["example topics", "example topics two", "widget topics"]);
    expect(striking.find((row) => row.dane.query === "example topics")?.dane).toMatchObject({
      impressions: 120,
      position: 6.2,
      page: "https://example.com/",
    });
    for (const row of striking) {
      expect(row.opis).toMatch(/title, h1/);
      expect(row.rollback).toMatch(/No change has been applied/);
    }

    const ctr = found.filter((row) => row.rule === "ctr-below-expected-query");
    expect(ctr.map((row) => row.dane.query)).toEqual(["widget topics"]);
    expect(ctr[0]?.dane).toMatchObject({ ctr: 0, impressions: 22, expectedCtr: expectedCtr(15.2) });
    expect(found.some((row) => row.rule === "ctr-below-expected-page")).toBe(false);

    const clusters = found.filter((row) => row.rule === "landing-page-cluster");
    expect(clusters.map((row) => row.dane.cluster).sort()).toEqual(["orange", "widget"]);
    expect(clusters.find((row) => row.dane.cluster === "widget")?.dane).toMatchObject({ impressions: 40 });
    expect(clusters.find((row) => row.dane.cluster === "orange")?.dane.queries).toEqual([
      expect.objectContaining({ query: "orange topics", impressions: 1 }),
      expect.objectContaining({ query: "oranges topics", impressions: 1 }),
    ]);
    const clustered = clusters.flatMap((row) => (row.dane.queries as Array<{ query: string }>).map((item) => item.query));
    expect(clustered).not.toContain("example topics");
    expect(clustered).not.toContain("example");

    const sitemap = found.find((row) => row.rule === "sitemap-blocked");
    expect(sitemap?.dane).toMatchObject({ url: "https://example.com/sitemap.xml", status: 403, bypass: false });
    expect(sitemap?.opis).toMatch(/Googlebot/);
    expect(sitemap?.uzasadnienie).toMatch(/Do not bypass the WAF/);
    expect(`${sitemap?.opis} ${sitemap?.uzasadnienie}`).not.toMatch(/user-agent|curl|disable the waf/i);
  });

  it("drops a cluster when a page path and h1 already match it, and honors higher thresholds", () => {
    const covered = rows({ extraPage: "https://example.com/widget" });
    expect(covered.filter((row) => row.rule === "landing-page-cluster").map((row) => row.dane.cluster)).toEqual(["orange"]);

    const stricter = rows({
      thresholds: {
        strikingDistance: { minImpressions: 50 },
        ctrVsExpected: { minImpressions: 24 },
        landingCluster: { minImpressions: 10 },
      },
    });
    expect(stricter.filter((row) => row.rule === "striking-distance-query").map((row) => row.dane.query).sort()).toEqual([
      "example topics",
      "example topics two",
    ]);
    expect(stricter.some((row) => row.rule === "ctr-below-expected-query")).toBe(false);
    expect(stricter.filter((row) => row.rule === "landing-page-cluster").map((row) => row.dane.cluster)).toEqual(["widget"]);
  });

  it("does not flag a sitemap that returned HTTP 200", () => {
    expect(rows({ status: 200 }).some((row) => row.rule === "sitemap-blocked")).toBe(false);
  });

  it("keeps striking distance and expected CTR closed at the threshold edges", () => {
    const band = (impressions: number, ctr: number, position: number) =>
      new Set(
        recommend({
          domain: "example.com",
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
