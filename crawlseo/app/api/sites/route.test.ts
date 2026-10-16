import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { lookup, create, findUnique } = vi.hoisted(() => ({
  lookup: vi.fn(),
  create: vi.fn(async ({ data }: { data: { domain: string; gscProperty: string } }) => ({
    id: "site-new",
    domain: data.domain,
    gscProperty: data.gscProperty,
    createdAt: new Date(),
  })),
  findUnique: vi.fn(async () => null),
}));

vi.mock("@/lib/db", () => ({
  db: { site: { findUnique, create } },
}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: { id: "user-1" } })) }));
vi.mock("@/lib/workers/gsc-sync", () => ({ syncGSCDataForSite: vi.fn(async () => undefined) }));
vi.mock("@/lib/alerts/evaluate", () => ({ ensureDefaultAlerts: vi.fn(async () => undefined) }));
vi.mock("dns/promises", () => ({ lookup, default: { lookup } }));

import { POST } from "./route";

function post(body: unknown) {
  return POST(new Request("http://localhost/api/sites", { method: "POST", body: JSON.stringify(body) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRAWL_ALLOWED_DOMAINS = "eurekalb.com,allowed-private.example";
  lookup.mockImplementation(async (host: string) => {
    if (host === "allowed-private.example") return [{ address: "10.0.0.5", family: 4 }];
    return [{ address: "93.184.216.34", family: 4 }];
  });
});

afterEach(() => {
  delete process.env.CRAWL_ALLOWED_DOMAINS;
});

describe("POST /api/sites allowlist", () => {
  it("rejects a property outside CRAWL_ALLOWED_DOMAINS before DNS or insert", async () => {
    const res = await post({ gscProperty: "sc-domain:evil.example" });

    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/CRAWL_ALLOWED_DOMAINS/);
    expect(lookup).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("creates an allowlisted public domain", async () => {
    const res = await post({ gscProperty: "https://www.eurekalb.com/" });

    expect(res.status).toBe(201);
    expect((await res.json()).domain).toBe("www.eurekalb.com");
    expect(create).toHaveBeenCalled();
  });

  it("still rejects an allowlisted domain that resolves to a private address", async () => {
    const res = await post({ gscProperty: "sc-domain:allowed-private.example" });

    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
});
