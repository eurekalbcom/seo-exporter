import { afterEach, describe, expect, it, vi } from "vitest";

const { queryRaw } = vi.hoisted(() => ({ queryRaw: vi.fn(async () => []) }));

vi.mock("@/lib/db", () => ({
  db: { $queryRaw: queryRaw },
}));

import { GET } from "./route";

afterEach(() => {
  delete process.env.METRICS_TOKEN;
  queryRaw.mockClear();
});

function metrics(authorization?: string) {
  return GET(new Request("http://localhost/metrics", { headers: authorization ? { authorization } : {} }));
}

describe("GET /metrics", () => {
  it("rejects a missing, wrong, or different-length bearer token before querying", async () => {
    process.env.METRICS_TOKEN = "metrics-secret";
    expect((await metrics()).status).toBe(401);
    expect((await metrics("Bearer wrong")).status).toBe(401);
    expect((await metrics("Bearer metrics-secret-extra")).status).toBe(401);
    expect((await metrics("metrics-secret")).status).toBe(401);
    delete process.env.METRICS_TOKEN;
    expect((await metrics("Bearer metrics-secret")).status).toBe(401);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("returns Prometheus text for the configured bearer token", async () => {
    process.env.METRICS_TOKEN = "metrics-secret";
    const res = await metrics("Bearer metrics-secret");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toContain("# TYPE seo_clicks gauge");
    expect(queryRaw).toHaveBeenCalled();
  });
});
