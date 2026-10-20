import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendDecision, readDecisions } from "../src/autopilot/approval";
import { main } from "../src/autopilot/cli";
import { crawlOrigins, type OriginCrawl } from "../src/autopilot/crawl";
import { loadFixtureSite } from "../src/autopilot/fixture-site";
import { parseGscPages, parseGscQueries } from "../src/autopilot/gsc-csv";
import { recommend } from "../src/autopilot/recommend";
import { readReport } from "../src/autopilot/report";

const ROOT = join(import.meta.dirname, "..");
const FIXTURE = join(ROOT, "fixtures/autopilot");
const ENV = { CRAWL_ALLOWED_DOMAINS: "bezkolejki.org,eurekalb.com" };
const QUERIES = join(FIXTURE, "gsc-queries.csv");
const PAGES = join(FIXTURE, "gsc-pages.csv");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

async function fixtureReport(out: string, now = "2026-01-15T05:00:00.000Z"): Promise<number> {
  return main(
    ["report", "--domain", "eurekalb.com", "--queries", QUERIES, "--pages", PAGES, "--fixture", join(FIXTURE, "site"), "--out", out],
    { env: ENV, now: () => new Date(now), stdout: () => undefined, stderr: () => undefined }
  );
}

describe("recommendations from the fixture", () => {
  it("emits one proposed row per finding, with evidence and no off-site target", async () => {
    const site = loadFixtureSite(join(FIXTURE, "site"));
    const crawl = await crawlOrigins({
      origins: [site.origin],
      fetchImpl: site.fetchImpl,
      env: ENV,
      minDelayMs: 0,
      sleep: async () => undefined,
    });
    const rows = recommend({
      domain: "eurekalb.com",
      crawl,
      queries: parseGscQueries(readFileSync(QUERIES, "utf8")),
      pages: parseGscPages(readFileSync(PAGES, "utf8")),
    });
    expect(rows.map((row) => row.rule).sort()).toEqual([
      "broken-link",
      "ctr-below-expected-page",
      "ctr-below-expected-query",
      "low-ctr-page",
      "low-ctr-query",
      "missing-canonical",
      "missing-h1",
      "missing-meta-description",
      "missing-title",
      "multiple-h1",
      "noindex",
      "redirect",
      "sitemap-not-ok",
      "striking-distance-query",
    ]);
    for (const row of rows) {
      expect(row.status).toBe("proposed");
      expect(row.opis.length).toBeGreaterThan(0);
      expect(row.uzasadnienie.length).toBeGreaterThan(0);
      expect(row.ryzyko.length).toBeGreaterThan(0);
      expect(row.rollback).toMatch(/No change has been applied/);
      expect(JSON.stringify(row.dane)).not.toMatch(/evil\.example/);
    }
    expect(rows.find((row) => row.rule === "low-ctr-query")?.dane).toMatchObject({
      query: "kolejka wizyta",
      impressions: 400,
      ctr: 0.005,
      position: 8.2,
    });
    expect(rows.some((row) => row.dane.query === "marka")).toBe(false);
  });

  it("does not invent tag findings for unparsed pages or sitemap gaps for URLs it never fetched", () => {
    const crawl: OriginCrawl[] = [
      {
        origin: "https://eurekalb.com",
        robotsStatus: 200,
        robotsOutcome: "rules",
        crawlDelaySeconds: null,
        sitemapUrls: ["https://eurekalb.com/pdf", "https://eurekalb.com/missing", "https://eurekalb.com/later"],
        pages: [
          {
            url: "https://eurekalb.com/pdf",
            status: 200,
            contentType: "application/pdf",
            title: null,
            metaDescription: null,
            canonical: null,
            h1: [],
            noindex: false,
            links: [],
            parsedHtml: false,
          },
          {
            url: "https://eurekalb.com/stub",
            status: 200,
            contentType: "text/html",
            title: null,
            metaDescription: null,
            canonical: null,
            h1: [],
            noindex: false,
            links: [],
            parsedHtml: false,
          },
          {
            url: "https://eurekalb.com/missing",
            status: 404,
            contentType: "text/html",
            title: null,
            metaDescription: null,
            canonical: null,
            h1: [],
            noindex: false,
            links: [],
            parsedHtml: false,
          },
        ],
        redirects: [],
        blockedByRobots: [],
        brokenLinks: [],
        skippedOffHost: [],
        requests: [
          { url: "https://eurekalb.com/pdf", method: "GET", status: 200 },
          { url: "https://eurekalb.com/stub", method: "GET", status: 200 },
          { url: "https://eurekalb.com/missing", method: "GET", status: 404 },
        ],
      },
    ];
    const rows = recommend({ domain: "eurekalb.com", crawl, queries: [], pages: [] });
    expect(rows.map((row) => row.rule)).toEqual(["sitemap-not-ok"]);
    expect(rows.find((row) => row.rule === "sitemap-not-ok")?.dane).toMatchObject({
      url: "https://eurekalb.com/missing",
      status: 404,
    });
  });

  it("keeps the low-CTR band closed at the documented edges", () => {
    const crawl = [] as Awaited<ReturnType<typeof crawlOrigins>>;
    const band = (impressions: number, ctr: number, position: number) =>
      recommend({
        domain: "eurekalb.com",
        crawl,
        queries: [{ query: "edge", clicks: 0, impressions, ctr, position }],
        pages: [],
      }).map((row) => row.rule);
    const rules = (impressions: number, ctr: number, position: number) => new Set(band(impressions, ctr, position));
    expect(rules(100, 0.029, 4).has("low-ctr-query")).toBe(true);
    expect(rules(99, 0.029, 4).has("low-ctr-query")).toBe(false);
    expect(rules(100, 0.03, 4).has("low-ctr-query")).toBe(false);
    expect(rules(100, 0.029, 3.9).has("low-ctr-query")).toBe(false);
    expect(rules(100, 0.029, 20).has("low-ctr-query")).toBe(true);
    expect(rules(100, 0.029, 20.1).has("low-ctr-query")).toBe(false);
  });
});

describe("approval log", () => {
  it("appends decisions and leaves every earlier byte in place", () => {
    const dir = mkdtempSync(join(tmpdir(), "seo-decisions-"));
    const log = join(dir, "nested/decisions.jsonl");
    const first = { at: "2026-01-15T05:00:00.000Z", id: "rec_0123456789ab", status: "approved" as const, actor: "operator" };
    appendDecision(log, first);
    const afterFirst = readFileSync(log);
    const second = { at: "2026-01-15T05:01:00.000Z", id: "rec_0123456789ac", status: "rejected" as const, actor: "operator" };
    appendDecision(log, second);
    const afterSecond = readFileSync(log);
    expect(afterSecond.subarray(0, afterFirst.length).equals(afterFirst)).toBe(true);
    expect(afterSecond.length).toBeGreaterThan(afterFirst.length);
    expect(readDecisions(log)).toEqual([first, second]);
    const broken = Buffer.concat([afterSecond, Buffer.from("{not json\n")]);
    writeFileSync(log, broken);
    expect(() => readDecisions(log)).toThrow();
    expect(readFileSync(log).equals(broken)).toBe(true);
  });

  it("only appends from the approval module", () => {
    const source = readFileSync(join(ROOT, "src/autopilot/approval.ts"), "utf8");
    expect(source).toMatch(/appendFileSync/);
    expect(source).not.toMatch(/writeFile|truncate|unlink|rmSync|renameSync/);
  });
});

describe("cli", () => {
  it("writes a fixture report and records approve then reject without rewriting it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seo-report-"));
    const stderr: string[] = [];
    const stdout: string[] = [];
    expect(await fixtureReport(dir)).toBe(0);
    const reportPath = join(dir, "report.json");
    const before = readFileSync(reportPath);
    const report = readReport(reportPath);
    const markdown = readFileSync(join(dir, "report.md"), "utf8");
    expect(report.recommendations).toHaveLength(14);
    expect(markdown).toMatch(/opis:/);
    expect(markdown).toMatch(/uzasadnienie:/);
    expect(markdown).toMatch(/ryzyko:/);
    expect(markdown).toMatch(/rollback:/);
    const id = report.recommendations[0]?.id ?? "";
    const log = join(dir, "decisions.jsonl");
    expect(
      await main(["approve", id, "--report", reportPath, "--log", log, "--actor", "echo"], {
        env: ENV,
        now: () => new Date("2026-01-15T06:00:00.000Z"),
        stdout: (chunk) => stdout.push(chunk),
        stderr: (chunk) => stderr.push(chunk),
      })
    ).toBe(0);
    expect(readFileSync(reportPath).equals(before)).toBe(true);
    const afterApprove = readFileSync(log);
    expect(
      await main(["reject", id, "--report", reportPath, "--log", log], {
        env: ENV,
        now: () => new Date("2026-01-15T06:05:00.000Z"),
        stdout: (chunk) => stdout.push(chunk),
        stderr: (chunk) => stderr.push(chunk),
      })
    ).toBe(0);
    const afterReject = readFileSync(log);
    expect(afterReject.subarray(0, afterApprove.length).equals(afterApprove)).toBe(true);
    expect(readDecisions(log).map((decision) => decision.status)).toEqual(["approved", "rejected"]);
    expect(stdout.join("")).toMatch(/rejected/);
    expect(readFileSync(reportPath).equals(before)).toBe(true);
    expect(
      await main(["approve", "rec_000000000000", "--report", reportPath, "--log", log], {
        stderr: (chunk) => stderr.push(chunk),
        stdout: () => undefined,
      })
    ).toBe(1);
    expect(readFileSync(log).equals(afterReject)).toBe(true);
    expect(stderr.join("")).toMatch(/Unknown recommendation/);
  });

  it("live crawl waits and sends only GET, and refuses any other host", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seo-live-"));
    const calls: Array<{ method: string; authorization: string | null }> = [];
    const waits: number[] = [];
    const code = await main(
      ["report", "--domain", "eurekalb.com", "--queries", QUERIES, "--pages", PAGES, "--live", "--out", dir],
      {
        env: ENV,
        now: () => new Date("2026-01-15T05:00:00.000Z"),
        stdout: () => undefined,
        stderr: () => undefined,
        sleep: async (ms) => {
          waits.push(ms);
        },
        fetchImpl: async (url, init) => {
          const headers = new Headers(init?.headers);
          calls.push({ method: (init?.method ?? "GET").toUpperCase(), authorization: headers.get("authorization") });
          const path = new URL(url).pathname;
          if (path === "/robots.txt") return new Response("User-agent: *\nDisallow:\n", { status: 200 });
          if (path === "/sitemap.xml") return new Response("missing", { status: 404 });
          return new Response("<html><head><title>Home</title></head><body><h1>Home</h1></body></html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        },
      }
    );
    expect(code).toBe(0);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.method === "GET" && call.authorization === null)).toBe(true);
    expect(waits.length).toBeGreaterThan(0);
    expect(waits.every((ms) => ms >= 1000)).toBe(true);
    let called = false;
    const refused = await main(
      ["report", "--domain", "example.com", "--queries", QUERIES, "--pages", PAGES, "--live", "--out", dir],
      {
        env: ENV,
        stderr: () => undefined,
        fetchImpl: async () => {
          called = true;
          return new Response("no");
        },
      }
    );
    expect(refused).toBe(1);
    expect(called).toBe(false);
  });
});

describe("fixture sample", () => {
  it("matches the committed report built from the fixture HTML and CSV", async () => {
    const dir = mkdtempSync(join(tmpdir(), "seo-sample-"));
    expect(await fixtureReport(dir)).toBe(0);
    expect(readFileSync(join(dir, "report.json"), "utf8")).toBe(readFileSync(join(FIXTURE, "sample/report.json"), "utf8"));
    expect(readFileSync(join(dir, "report.md"), "utf8")).toBe(readFileSync(join(FIXTURE, "sample/report.md"), "utf8"));
  });
});

describe("read-only surface", () => {
  it("has no write method, no Google API client, and no WRITE_MODE branch", () => {
    const source = walk(join(ROOT, "src/autopilot"))
      .filter((path) => path.endsWith(".ts"))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(source).not.toMatch(/["'](POST|PUT|PATCH|DELETE)["']/);
    expect(source).not.toMatch(/WRITE_MODE/);
    expect(source).not.toMatch(/googleapis|oauth|bing\.com/i);
  });
});
