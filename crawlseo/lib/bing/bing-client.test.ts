import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { encrypt } from "@/lib/encryption";

const db = vi.hoisted(() => ({ apiKey: { findUnique: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db }));

import { fetchBingCrawlStats, fetchBingTraffic, getBingApiKey } from "./bing-client";
import { redactUrl } from "./redact-url";

function bingAnswers(rows: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ d: rows })))
  );
}

beforeAll(() => {
  process.env.NEXTAUTH_SECRET = "test-secret-for-vitest-only";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("redactUrl", () => {
  it("replaces the apikey value and leaves the rest of the URL", () => {
    const raw =
      "https://ssl.bing.com/webmaster/api.svc/json/GetUserSites?siteUrl=https%3A%2F%2Fa.example%2F&apikey=super-secret-bing-key-9f3a";
    expect(redactUrl(raw)).toBe(
      "https://ssl.bing.com/webmaster/api.svc/json/GetUserSites?siteUrl=https%3A%2F%2Fa.example%2F&apikey=[REDACTED]"
    );
    expect(redactUrl("https://ssl.bing.com/x?APIKEY=abc&b=1")).toBe(
      "https://ssl.bing.com/x?APIKEY=[REDACTED]&b=1"
    );
    expect(redactUrl("no key here")).toBe("no key here");
  });
});

describe("getBingApiKey", () => {
  // Single-key providers keep the secret in encryptedPassword and leave
  // encryptedLogin null, the convention the PageSpeed key set.
  it("reads the key from encryptedPassword", async () => {
    db.apiKey.findUnique.mockResolvedValue({
      encryptedLogin: null,
      encryptedPassword: encrypt("bing-key"),
    });
    expect(await getBingApiKey("user-1")).toBe("bing-key");
  });
});

describe("a counter Bing leaves out of a row", () => {
  // Absent is not zero: the columns are nullable so "not measured" and
  // "measured zero" stay distinct.
  it("stays null in traffic rows", async () => {
    bingAnswers([{ Date: "/Date(1747983600000-0700)/", Clicks: 3 }]);
    expect(await fetchBingTraffic("k", "https://a.example/")).toEqual([
      { date: "2025-05-23", clicks: 3, impressions: null },
    ]);
  });

  it("stays null in crawl rows while a reported zero stays zero", async () => {
    bingAnswers([{ Date: "/Date(1747983600000-0700)/", CrawledPages: 0 }]);
    const [day] = await fetchBingCrawlStats("k", "https://a.example/");
    expect(day.crawledPages).toBe(0);
    expect(day.inIndex).toBeNull();
    expect(day.code5xx).toBeNull();
  });
});

describe("a network failure", () => {
  it("does not keep the API key in the error message or stack", async () => {
    const key = "super-secret-bing-key-9f3a";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const requested = String(input);
        const cause = new Error(`connect ECONNREFUSED ${requested}`);
        cause.stack = `Error: connect ECONNREFUSED ${requested}\n    at connect (${requested})`;
        const error = new TypeError(`fetch failed ${requested}`, { cause });
        error.stack = `TypeError: fetch failed ${requested}\n    at fetch (${requested}:1:1)`;
        throw error;
      })
    );

    let caught: unknown;
    try {
      await fetchBingTraffic(key, "https://a.example/");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    if (!(caught instanceof Error)) return;
    expect(caught.message).not.toContain(key);
    expect(caught.stack).not.toContain(key);
    expect(caught.message).toContain("apikey=[REDACTED]");
    expect(caught.cause).toBeInstanceOf(Error);
    if (!(caught.cause instanceof Error)) return;
    expect(caught.cause.message).not.toContain(key);
    expect(caught.cause.stack).not.toContain(key);
  });
});
