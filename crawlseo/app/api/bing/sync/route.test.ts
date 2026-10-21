import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ site: { findUnique: vi.fn() } }));
const sync = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "user-1" } }) }));
vi.mock("@/lib/db", () => ({ db }));
vi.mock("@/lib/workers/bing-sync", () => ({ syncBingDataForSite: sync }));

import { POST } from "./route";

const post = (siteId: string) =>
  POST(
    new Request("http://localhost/api/bing/sync", {
      method: "POST",
      body: JSON.stringify({ siteId }),
    })
  );

describe("POST /api/bing/sync", () => {
  const saved = process.env.BING_ENABLED;

  beforeEach(() => {
    process.env.BING_ENABLED = "true";
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.BING_ENABLED;
    else process.env.BING_ENABLED = saved;
  });

  it("answers 404 when Bing is disabled and does not sync", async () => {
    delete process.env.BING_ENABLED;
    expect((await post("site-a")).status).toBe(404);
    expect(db.site.findUnique).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  // Like /api/gsc/sync: a site that does not exist and someone else's site get
  // the same 404, so the status does not reveal which ids exist.
  it("answers 404 for an unknown site and for another user's site", async () => {
    db.site.findUnique.mockResolvedValueOnce(null);
    expect((await post("nope")).status).toBe(404);

    db.site.findUnique.mockResolvedValueOnce({
      userId: "user-2",
      bingSite: "https://a.example/",
    });
    expect((await post("site-b")).status).toBe(404);

    expect(sync).not.toHaveBeenCalled();
  });

  it("answers 400 when the site has no Bing property", async () => {
    db.site.findUnique.mockResolvedValueOnce({ userId: "user-1", bingSite: null });
    expect((await post("site-a")).status).toBe(400);
    expect(sync).not.toHaveBeenCalled();
  });

  it("redacts a Bing key from a thrown sync error", async () => {
    const key = "secret/key 9f3a";
    db.site.findUnique.mockResolvedValueOnce({
      userId: "user-1",
      bingSite: "https://a.example/",
    });
    sync.mockRejectedValueOnce(new Error(`failed apikey=${key} APIKEY:${key.toUpperCase()}`));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await post("site-a");
      expect(res.status).toBe(500);
      const body = JSON.stringify(await res.json());
      expect(body).not.toContain(key);
      expect(body.toUpperCase()).not.toContain(key.toUpperCase());
      const logged = spy.mock.calls
        .flat()
        .map((part) => (part instanceof Error ? `${part.message}\n${part.stack ?? ""}` : String(part)))
        .join("\n");
      expect(logged).not.toContain(key);
      expect(logged.toUpperCase()).not.toContain(key.toUpperCase());
    } finally {
      spy.mockRestore();
    }
  });
});
