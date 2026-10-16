import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("dns/promises", () => ({
  lookup: async () => [{ address: "93.184.216.34", family: 4 }],
  default: { lookup: async () => [{ address: "93.184.216.34", family: 4 }] },
}));
vi.mock("@/lib/db", () => ({ db: {} }));

import { fetchText } from "./engine";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CRAWL_ALLOWED_DOMAINS;
});

describe("crawl allowlist on every hop", () => {
  it("does not fetch a redirect target outside CRAWL_ALLOWED_DOMAINS", async () => {
    process.env.CRAWL_ALLOWED_DOMAINS = "bezkolejki.org";
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(String(url));
      return new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/phish" },
      });
    });

    await expect(fetchText("https://bezkolejki.org/start")).resolves.toBeNull();
    expect(calls).toEqual(["https://bezkolejki.org/start"]);
  });

  it("follows a redirect that stays on the allowlist", async () => {
    process.env.CRAWL_ALLOWED_DOMAINS = "bezkolejki.org";
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const current = String(url);
      calls.push(current);
      if (current === "https://bezkolejki.org/start") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://www.bezkolejki.org/next" },
        });
      }
      return new Response("ok", { status: 200 });
    });

    await expect(fetchText("https://bezkolejki.org/start")).resolves.toBe("ok");
    expect(calls).toEqual(["https://bezkolejki.org/start", "https://www.bezkolejki.org/next"]);
  });

  it("does not fetch a seed host that is off the allowlist", async () => {
    process.env.CRAWL_ALLOWED_DOMAINS = "bezkolejki.org";
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(String(url));
      return new Response("no", { status: 200 });
    });

    await expect(fetchText("https://evil.example/")).resolves.toBeNull();
    expect(calls).toEqual([]);
  });
});
