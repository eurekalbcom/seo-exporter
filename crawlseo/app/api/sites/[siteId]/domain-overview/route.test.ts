import { beforeEach, describe, expect, it, vi } from "vitest";

const { auth, db, getSitePeriodMetrics } = vi.hoisted(() => ({
  auth: vi.fn(),
  db: {
    site: { findUnique: vi.fn() },
    keyword: { groupBy: vi.fn() },
  },
  getSitePeriodMetrics: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("@/lib/db", () => ({ db }));
vi.mock("@/lib/seo-metrics", () => ({ getSitePeriodMetrics }));

import { GET } from "./route";

const metrics = {
  current: { clicks: 7, impressions: 80, avgPosition: 12 },
  previous: { clicks: 5, impressions: 60, avgPosition: 14 },
  deltas: { clicks: 2, impressions: 20, avgPosition: -2 },
};

function get(domain?: string) {
  const url = new URL("http://localhost/api/sites/site-1/domain-overview");
  if (domain !== undefined) url.searchParams.set("domain", domain);
  return GET(new Request(url), { params: Promise.resolve({ siteId: "site-1" }) });
}

beforeEach(() => {
  vi.resetAllMocks();
  auth.mockResolvedValue({ user: { id: "user-1" } });
  db.site.findUnique.mockResolvedValue({ userId: "user-1", domain: "own.example" });
  getSitePeriodMetrics.mockResolvedValue(metrics);
  db.keyword.groupBy.mockResolvedValue([{ query: "own keyword" }]);
});

describe("GET /api/sites/[siteId]/domain-overview", () => {
  it("uses Search Console for the stored site", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      source: "gsc",
      domain: "own.example",
      overview: { organicKeywords: 1, organicTraffic: 7 },
      metrics,
    });
    expect(getSitePeriodMetrics).toHaveBeenCalledWith("site-1", 28);
  });

  it.each([
    ["competitor.com", "competitor.com"],
    [" https://www.Competitor.com/blog/?ref=test#about ", "competitor.com"],
    ["www.competitor.com/", "competitor.com"],
    ["https://shop.competitor.com/", "shop.competitor.com"],
  ])("does not return own-site data for competitor %s", async (input, target) => {
    const response = await get(input);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      source: "none",
      domain: target,
      overview: null,
      backlinks: null,
    });
    expect(getSitePeriodMetrics).not.toHaveBeenCalled();
    expect(db.keyword.groupBy).not.toHaveBeenCalled();
  });

  it.each([undefined, "https://own.example/"])("keeps the own-site GSC data for %s", async (domain) => {
    const response = await get(domain);
    expect(await response.json()).toMatchObject({
      source: "gsc",
      domain: "own.example",
      overview: { organicKeywords: 1, organicTraffic: 7 },
      metrics,
    });
    expect(getSitePeriodMetrics).toHaveBeenCalledWith("site-1", 28);
  });

  it.each(["", "   ", "https://", "not a domain"])("rejects invalid comparison input %j", async (domain) => {
    const response = await get(domain);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid comparison domain" });
    expect(getSitePeriodMetrics).not.toHaveBeenCalled();
  });

  it.each(["own-site.com", "www.own-site.com", "https://WWW.Own-Site.com/blog"])(
    "treats %s as the own site when the site is stored with www",
    async (domain) => {
      db.site.findUnique.mockResolvedValue({ userId: "user-1", domain: "www.own-site.com" });
      const response = await get(domain);
      expect(await response.json()).toMatchObject({ source: "gsc", domain: "www.own-site.com", metrics });
      expect(getSitePeriodMetrics).toHaveBeenCalledWith("site-1", 28);
    }
  );

  it("does not apply the public-domain check to the own site", async () => {
    db.site.findUnique.mockResolvedValue({ userId: "user-1", domain: "staging.internal" });
    const response = await get("https://staging.internal/");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ source: "gsc", domain: "staging.internal" });
  });

  it.each([
    "localhost",
    "http://localhost:3000/",
    "127.0.0.1",
    "https://10.0.0.5/admin",
    "[::1]",
    "http://[2606:4700::1111]/",
    "intranet",
    "printer.local",
    "shop.test",
    "nothing.invalid",
    "competitor.example",
    "db.internal",
    "app.localhost",
    "2130706433",
    "0x7f000001",
    "127.1",
    "user@localhost",
    "localhost.",
    "router.home.arpa",
    "hidden.onion",
    "nas.lan",
  ])("rejects %s with a plain message", async (domain) => {
    const response = await get(domain);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/^Enter a public domain such as example\.com\./);
    expect(getSitePeriodMetrics).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    auth.mockResolvedValue(null);
    expect((await get("competitor.com")).status).toBe(401);
    expect(db.site.findUnique).not.toHaveBeenCalled();
  });

  it.each([null, { userId: "other-user", domain: "other.example" }])("still requires ownership of the site", async (site) => {
    db.site.findUnique.mockResolvedValue(site);
    expect((await get("competitor.com")).status).toBe(404);
  });
});
