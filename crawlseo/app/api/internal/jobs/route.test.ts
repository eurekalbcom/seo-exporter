import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { db, syncGSCDataForSite, startSiteCrawl, syncVitalsForSite } = vi.hoisted(() => ({
  db: { site: { findMany: vi.fn() } },
  syncGSCDataForSite: vi.fn(),
  startSiteCrawl: vi.fn(),
  syncVitalsForSite: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db }));
vi.mock("@/lib/workers/gsc-sync", () => ({ syncGSCDataForSite }));
vi.mock("@/lib/workers/vitals-sync", () => ({ syncVitalsForSite }));
vi.mock("@/lib/crawler/lifecycle", () => ({ startSiteCrawl }));

import { POST } from "./route";

const previousAllowlist = process.env.CRAWL_ALLOWED_DOMAINS;

function call(domain: string, job = "gsc-sync") {
  return POST(
    new Request("http://localhost/api/internal/jobs", {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ job, domain }),
    })
  );
}

beforeEach(() => {
  process.env.ORCHESTRATOR_TOKEN = "secret";
  process.env.CRAWL_ALLOWED_DOMAINS = "bezkolejki.org,eurekalb.com";
  db.site.findMany.mockReset();
  syncGSCDataForSite.mockReset();
  startSiteCrawl.mockReset();
  syncVitalsForSite.mockReset();
});

afterEach(() => {
  delete process.env.ORCHESTRATOR_TOKEN;
  if (previousAllowlist === undefined) delete process.env.CRAWL_ALLOWED_DOMAINS;
  else process.env.CRAWL_ALLOWED_DOMAINS = previousAllowlist;
});

describe("POST /api/internal/jobs", () => {
  it("finds a www URL-prefix property from the comparable host", async () => {
    db.site.findMany.mockResolvedValue([{ id: "s-www", userId: "u1", domain: "www.bezkolejki.org" }]);
    syncGSCDataForSite.mockResolvedValue({ success: true });

    const res = await call("bezkolejki.org");

    expect(res.status).toBe(200);
    expect(db.site.findMany).toHaveBeenCalledWith({
      where: { domain: { in: ["bezkolejki.org", "www.bezkolejki.org"] } },
      select: { id: true, userId: true, domain: true },
    });
    expect(syncGSCDataForSite).toHaveBeenCalledWith("u1", "s-www");
  });

  it("refuses to pick a tenant when two accounts share the host", async () => {
    db.site.findMany.mockResolvedValue([
      { id: "s1", userId: "u1", domain: "bezkolejki.org" },
      { id: "s2", userId: "u2", domain: "www.bezkolejki.org" },
    ]);

    const res = await call("bezkolejki.org");

    expect(res.status).toBe(409);
    expect(syncGSCDataForSite).not.toHaveBeenCalled();
    expect(startSiteCrawl).not.toHaveBeenCalled();
    expect(syncVitalsForSite).not.toHaveBeenCalled();
  });

  it("404s when neither the apex nor the www host is stored", async () => {
    db.site.findMany.mockResolvedValue([]);
    const res = await call("eurekalb.com", "vitals");
    expect(res.status).toBe(404);
    expect(syncVitalsForSite).not.toHaveBeenCalled();
  });
});
