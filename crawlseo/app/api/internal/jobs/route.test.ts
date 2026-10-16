import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { findFirst } = vi.hoisted(() => ({ findFirst: vi.fn() }));

vi.mock("@/lib/db", () => ({
  db: { site: { findFirst } },
}));
vi.mock("@/lib/crawler/lifecycle", () => ({ startSiteCrawl: vi.fn() }));
vi.mock("@/lib/workers/gsc-sync", () => ({ syncGSCDataForSite: vi.fn() }));
vi.mock("@/lib/workers/vitals-sync", () => ({ syncVitalsForSite: vi.fn() }));

import { POST } from "./route";

function post(authorization?: string, body: unknown = { job: "gsc-sync", domain: "eurekalb.com" }) {
  return POST(
    new Request("http://localhost/api/internal/jobs", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  findFirst.mockReset();
  findFirst.mockResolvedValue(null);
  process.env.ORCHESTRATOR_TOKEN = "orch-secret";
  process.env.CRAWL_ALLOWED_DOMAINS = "eurekalb.com";
});

afterEach(() => {
  delete process.env.ORCHESTRATOR_TOKEN;
  delete process.env.CRAWL_ALLOWED_DOMAINS;
});

describe("ORCHESTRATOR_TOKEN", () => {
  it("answers 404 for a missing, wrong, or different-length token and does not touch the database", async () => {
    expect((await post()).status).toBe(404);
    expect((await post("Bearer no")).status).toBe(404);
    expect((await post("Bearer orch-secret-longer")).status).toBe(404);
    expect((await post("orch-secret")).status).toBe(404);
    delete process.env.ORCHESTRATOR_TOKEN;
    expect((await post("Bearer orch-secret")).status).toBe(404);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("accepts the token with a length-safe compare and then applies the crawl allowlist", async () => {
    expect((await post("Bearer orch-secret")).status).toBe(404);
    expect(findFirst).toHaveBeenCalled();

    findFirst.mockClear();
    const offList = await post("Bearer orch-secret", { job: "crawl", domain: "evil.example" });
    expect(offList.status).toBe(403);
    expect(findFirst).not.toHaveBeenCalled();
  });
});
