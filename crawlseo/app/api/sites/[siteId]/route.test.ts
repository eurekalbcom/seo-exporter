import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { db, tx, lookup, row } = vi.hoisted(() => {
  const row = {
    id: "site-1",
    userId: "user-1",
    domain: "quilltab.app",
    gscProperty: "sc-domain:quilltab.app",
    bingSite: "https://old.example/" as string | null,
  };
  const update = vi.fn(async ({ data }: { data: Partial<typeof row> }) => {
    Object.assign(row, data);
    return {
      id: row.id,
      domain: row.domain,
      gscProperty: row.gscProperty,
      bingSite: row.bingSite,
      updatedAt: new Date(),
    };
  });
  // What the PUT sees inside its locked transaction.
  const tx = {
    $queryRaw: vi.fn(),
    bingSearchWeekly: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    bingDaily: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    site: { update },
  };
  return {
    row,
    tx,
    lookup: vi.fn(),
    db: {
      site: { findUnique: vi.fn(async () => ({ userId: row.userId })), update },
      $transaction: vi.fn(async (run: (t: typeof tx) => Promise<unknown>) => run(tx)),
    },
  };
});

vi.mock("@/lib/db", () => ({ db }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: { id: "user-1" } })) }));
// Only DNS is faked, so the real assertPublicDomain decides what is private.
vi.mock("dns/promises", () => ({ lookup, default: { lookup } }));

import { PUT } from "./route";

const DNS: Record<string, string> = {
  "internal.example": "10.0.0.5",
  "loopback.example": "127.0.0.1",
  "metadata.example": "169.254.169.254",
  "allowed-private.example": "10.0.0.5",
  "new-site.com": "93.184.216.34",
  "evil.example": "93.184.216.34",
};

function put(body: unknown) {
  return PUT(
    new Request("http://localhost/api/sites/site-1", { method: "PUT", body: JSON.stringify(body) }),
    { params: Promise.resolve({ siteId: "site-1" }) }
  );
}

beforeEach(() => {
  process.env.CRAWL_ALLOWED_DOMAINS =
    "quilltab.app,new-site.com,new.example,old.example,b.example,missing.eurekalb.com,allowed-private.example";
  vi.clearAllMocks();
  Object.assign(row, {
    domain: "quilltab.app",
    gscProperty: "sc-domain:quilltab.app",
    bingSite: "https://old.example/",
  });
  tx.$queryRaw.mockImplementation(async () => [{ bingSite: row.bingSite }]);
  lookup.mockImplementation(async (host: string) => {
    const address = DNS[host] ?? host;
    return [{ address, family: address.includes(":") ? 6 : 4 }];
  });
});

afterEach(() => {
  delete process.env.CRAWL_ALLOWED_DOMAINS;
});

describe("PUT /api/sites/[siteId] domain", () => {
  it.each(["internal.example", "loopback.example", "metadata.example", "127.0.0.1", "http://127.0.0.1:8080", "evil.example"])(
    "rejects %s because it is off CRAWL_ALLOWED_DOMAINS and leaves the row unchanged",
    async (domain) => {
      const res = await put({ domain });

      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/CRAWL_ALLOWED_DOMAINS/);
      expect(lookup).not.toHaveBeenCalled();
      expect(db.site.update).not.toHaveBeenCalled();
      expect(row.domain).toBe("quilltab.app");
    }
  );

  it("still rejects an allowlisted domain that resolves to a private address", async () => {
    const res = await put({ domain: "allowed-private.example" });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Domain must resolve to a public IP address" });
    expect(db.site.update).not.toHaveBeenCalled();
  });

  it("rejects a domain that does not resolve", async () => {
    lookup.mockRejectedValueOnce(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }));

    const res = await put({ domain: "missing.eurekalb.com" });

    expect(res.status).toBe(400);
    expect(db.site.update).not.toHaveBeenCalled();
    expect(row.domain).toBe("quilltab.app");
  });

  it("accepts a domain that resolves to a public IP", async () => {
    const res = await put({ domain: "new-site.com" });

    expect(res.status).toBe(200);
    expect((await res.json()).domain).toBe("new-site.com");
    expect(row.domain).toBe("new-site.com");
  });

  it("checks and stores the normalized hostname, not the raw input", async () => {
    const blocked = await put({ domain: "https://allowed-private.example/blog/" });

    expect(blocked.status).toBe(400);
    expect(lookup).toHaveBeenCalledWith("allowed-private.example", { all: true });
    expect(row.domain).toBe("quilltab.app");

    const allowed = await put({ domain: "https://new-site.com/blog/" });

    expect(allowed.status).toBe(200);
    expect(lookup).toHaveBeenLastCalledWith("new-site.com", { all: true });
    expect(row.domain).toBe("new-site.com");
  });

  it("does not resolve anything when only gscProperty changes", async () => {
    const res = await put({ gscProperty: "sc-domain:quilltab.app" });

    expect(res.status).toBe(200);
    expect(lookup).not.toHaveBeenCalled();
    expect(row.domain).toBe("quilltab.app");
  });

  it("rejects a gsc property and a Bing URL outside the allowlist", async () => {
    expect((await put({ gscProperty: "sc-domain:evil.example" })).status).toBe(403);
    expect((await put({ bingSite: "https://evil.example/" })).status).toBe(403);
    expect(db.site.update).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    "https://evil.com/?x=allowed.pl",
    "https://evil.com#allowed.pl",
    "https://allowed.pl.evil.com",
    "https://allowed.pl@evil.com",
  ])("rejects Bing URL %s whose hostname is not the allowlisted host", async (bingSite) => {
    process.env.CRAWL_ALLOWED_DOMAINS = "allowed.pl";

    const res = await put({ bingSite });

    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/CRAWL_ALLOWED_DOMAINS/);
    expect(db.site.update).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(row.bingSite).toBe("https://old.example/");
  });

  it("returns a generic 500 and logs the exception instead of its message", async () => {
    db.site.update.mockRejectedValueOnce(new Error("secret-db-token-should-not-leak"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await put({ domain: "new-site.com" });
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body).toEqual({ error: "Failed to update site" });
      expect(JSON.stringify(body)).not.toContain("secret-db-token-should-not-leak");
      expect(errorSpy.mock.calls.flat().join(" ")).toContain("secret-db-token-should-not-leak");
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("PUT /api/sites/[siteId] with a Bing property", () => {
  // Changing the Bing property wipes the old property's rows. The decision and
  // the wipe happen under the Site row lock, in the transaction that also
  // updates the row: a sync in flight (bing-sync.ts holds the same lock) and a
  // concurrent PUT both serialise against it, and a failed update (say a
  // duplicate domain) rolls the wipe back.
  it("wipes the old rows under the Site row lock, before the update", async () => {
    const res = await put({ bingSite: "https://new.example/" });

    expect(res.status).toBe(200);
    expect((await res.json()).bingSite).toBe("https://new.example/");
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    const [sql] = tx.$queryRaw.mock.calls[0];
    expect(sql.join("?")).toMatch(/FOR NO KEY UPDATE/);
    expect(tx.bingDaily.deleteMany).toHaveBeenCalledWith({ where: { siteId: "site-1" } });
    expect(tx.bingSearchWeekly.deleteMany).toHaveBeenCalledWith({ where: { siteId: "site-1" } });
    expect(tx.bingDaily.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.site.update.mock.invocationCallOrder[0]
    );
    expect(lookup).not.toHaveBeenCalled();
  });

  it("decides from the locked value, not from the earlier read", async () => {
    // Another request moved the property after the ownership read. Saving the
    // value that read returned is still a change, so the rows must go.
    tx.$queryRaw.mockResolvedValueOnce([{ bingSite: "https://b.example/" }]);

    const res = await put({ bingSite: "https://old.example/" });

    expect(res.status).toBe(200);
    expect(tx.bingDaily.deleteMany).toHaveBeenCalled();
    expect(row.bingSite).toBe("https://old.example/");
  });

  it("leaves the rows alone when the property does not change", async () => {
    const res = await put({ bingSite: "https://old.example/" });

    expect(res.status).toBe(200);
    expect(tx.bingDaily.deleteMany).not.toHaveBeenCalled();
    expect(tx.bingSearchWeekly.deleteMany).not.toHaveBeenCalled();
  });

  it("rejects a property that is not a string without touching the rows", async () => {
    expect((await put({ bingSite: 0 })).status).toBe(400);
    expect((await put({ bingSite: ["https://new.example/"] })).status).toBe(400);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.site.update).not.toHaveBeenCalled();
  });

  it("rejects a property that is not an http(s) URL", async () => {
    expect((await put({ bingSite: "ftp://new.example/" })).status).toBe(400);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.site.update).not.toHaveBeenCalled();
  });
});
