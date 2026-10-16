import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { encrypt } from "@/lib/encryption";

const db = vi.hoisted(() => ({ apiKey: { findUnique: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db }));

import {
  BingKeyMissingError,
  fetchBingCrawlStats,
  fetchBingTraffic,
  getBingApiKey,
  testBingKey,
} from "./bing-client";
import { redactError, redactUrl } from "./redact-url";

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

  it("redacts a fragment and every apikey parameter", () => {
    expect(redactUrl("https://ssl.bing.com/x?apikey=one&foo=1&apikey=two")).toBe(
      "https://ssl.bing.com/x?apikey=[REDACTED]&foo=1&apikey=[REDACTED]"
    );
    expect(redactUrl("https://ssl.bing.com/x?apikey=one#section")).toBe(
      "https://ssl.bing.com/x?apikey=[REDACTED]#section"
    );
    expect(redactUrl("https://ssl.bing.com/x#apikey=one")).toBe(
      "https://ssl.bing.com/x#apikey=[REDACTED]"
    );
    expect(redactUrl("https://ssl.bing.com/x?apikey=one#apikey=two")).toBe(
      "https://ssl.bing.com/x?apikey=[REDACTED]#apikey=[REDACTED]"
    );
  });

  it("redacts the literal key and its encoded forms", () => {
    const key = "secret/key 9f3a";
    const encoded = encodeURIComponent(key);
    const queried = new URLSearchParams({ apikey: key }).toString().slice("apikey=".length);
    expect(redactUrl(`body ${key} and ${encoded} and ${queried} #apikey=${key}`, key)).toBe(
      "body [REDACTED] and [REDACTED] and [REDACTED] #apikey=[REDACTED]"
    );
    expect(redactUrl(`https://ssl.bing.com/x?apikey=someone-else&note=${key}`, key)).toBe(
      "https://ssl.bing.com/x?apikey=[REDACTED]&note=[REDACTED]"
    );
  });

  it("redacts percent-encoding without regard to hex case", () => {
    const key = "a/b c";
    const encoded = encodeURIComponent(key);
    const queried = new URLSearchParams({ apikey: key }).toString().slice("apikey=".length);
    expect(encoded).toBe("a%2Fb%20c");
    expect(queried).toBe("a%2Fb+c");
    expect(redactUrl(`x ${encoded.toLowerCase()} y ${queried.replace("%2F", "%2f")} z`, key)).toBe(
      "x [REDACTED] y [REDACTED] z"
    );
    expect(redactUrl("pre%2fsuf", "pre%2Fsuf")).toBe("[REDACTED]");
  });

  it("redacts a double-encoded percent sequence", () => {
    const key = "a/b c";
    const once = encodeURIComponent(key);
    const twice = encodeURIComponent(once);
    expect(once).toBe("a%2Fb%20c");
    expect(twice).toBe("a%252Fb%2520c");
    expect(redactUrl(twice.toLowerCase(), key)).toBe("[REDACTED]");
    expect(redactUrl(once.toLowerCase(), key)).toBe("[REDACTED]");
    const queried = new URLSearchParams({ apikey: key }).toString().slice("apikey=".length);
    const doubled = queried.replace(/%/g, "%25").replace("%252F", "%252f");
    expect(redactUrl(doubled, key)).toBe("[REDACTED]");
  });

  it("redacts tokens, a JSON apikey, and auth headers without knowing the key", () => {
    expect(
      redactUrl(
        "https://x.test/cb?token=sek&access_token=a&refresh_token=b&client_secret=c&api_key=d&ok=1"
      )
    ).toBe(
      "https://x.test/cb?token=[REDACTED]&access_token=[REDACTED]&refresh_token=[REDACTED]&client_secret=[REDACTED]&api_key=[REDACTED]&ok=1"
    );
    expect(redactUrl('{"apikey":"sek","ok":1}')).toBe('{"apikey":"[REDACTED]","ok":1}');
    expect(
      redactUrl(
        "{\"api_key\":\"sek\",\"token\":'t',\"access_token\":\"a\",\"refresh_token\":\"r\",\"client_secret\":\"c\"}"
      )
    ).toBe(
      "{\"api_key\":\"[REDACTED]\",\"token\":'[REDACTED]',\"access_token\":\"[REDACTED]\",\"refresh_token\":\"[REDACTED]\",\"client_secret\":\"[REDACTED]\"}"
    );
    expect(redactUrl("{'client_secret':'sek'}")).toBe("{'client_secret':'[REDACTED]'}");
    expect(redactUrl("Authorization: Bearer sekret")).toBe("Authorization: [REDACTED]");
    expect(redactUrl('"Authorization":"Basic dXNlcjpwYXNz"')).toBe(
      '"Authorization":"[REDACTED]"'
    );
    expect(redactUrl('{\\"apikey\\":\\"sek\\"}')).toBe('{\\"apikey\\":\\"[REDACTED]\\"}');
  });

  it("redacts every Authorization scheme through the end of its value", () => {
    const token = "Authorization: Token xyz-token-9f3a";
    const bot = "Authorization: Bot bot-secret-9f3a";
    const apiKey = "Authorization: ApiKey sk-live-9f3a";
    const digest =
      'Authorization: Digest username="alice", realm="example.com", nonce="nonce-9f3a", uri="/x", response="digest-response-9f3a"';
    const aws4 =
      "Authorization: AWS4-HMAC-SHA256 Credential=AKIAFAKE0000000000/20130524/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=signature-9f3a";
    const lower = "authorization: Token xyz-token-9f3a";
    const quotedBearer = '"Bearer abc def"';

    expect(redactUrl(token)).toBe("Authorization: [REDACTED]");
    expect(redactUrl(bot)).toBe("Authorization: [REDACTED]");
    expect(redactUrl(apiKey)).toBe("Authorization: [REDACTED]");
    expect(redactUrl(digest)).toBe("Authorization: [REDACTED]");
    expect(redactUrl(aws4)).toBe("Authorization: [REDACTED]");
    expect(redactUrl(lower)).toBe("authorization: [REDACTED]");
    expect(redactUrl(quotedBearer)).toBe('"Bearer [REDACTED]"');
    expect(redactUrl('{\\"Authorization\\":\\"Basic dXNlcjpwYXNz\\"}')).toBe(
      '{\\"Authorization\\":\\"[REDACTED]\\"}'
    );
    expect(redactUrl("Authorization: Token abc,def")).toBe("Authorization: [REDACTED]");
    expect(redactUrl("Authorization: Token abc,def\nkeep")).toBe("Authorization: [REDACTED]\nkeep");
    expect(redactUrl('"token":12345')).toBe('"token":[REDACTED]');
    expect(redactUrl('{"token":12345,"ok":1}')).toBe('{"token":[REDACTED],"ok":1}');
    expect(redactUrl('{"token":12345}')).toBe('{"token":[REDACTED]}');
    expect(redactUrl('{"token":true,"ok":1}')).toBe('{"token":[REDACTED],"ok":1}');
    expect(redactUrl('{"token":null}')).toBe('{"token":[REDACTED]}');
    expect(redactUrl('{\\"token\\":12345,"ok":1}')).toBe('{\\"token\\":[REDACTED],"ok":1}');
    expect(redactUrl('{"token":[1,"S"]}')).toBe('{"token":[REDACTED]}');
    expect(redactUrl('{"token":{"a":"x","b":"S"}}')).toBe('{"token":[REDACTED]}');
    expect(redactUrl('{"token":{"a":"\\"}\S"}}')).toBe('{"token":[REDACTED]}');
    expect(redactUrl('{"token":[1,"S"\nkeep]')).toBe('{"token":[REDACTED]\nkeep]');
    expect(redactUrl('{"token":[1,"S"]}')).not.toContain("S");
    expect(redactUrl('{"token":{"a":"x","b":"S"}}')).not.toContain("S");
    expect(redactUrl('{"token":[1,"S"\nkeep]')).not.toContain("S");

    for (const secret of [
      "xyz-token-9f3a",
      "bot-secret-9f3a",
      "sk-live-9f3a",
      "alice",
      "example.com",
      "nonce-9f3a",
      "digest-response-9f3a",
      "AKIAFAKE0000000000",
      "signature-9f3a",
      "abc",
      "def",
    ]) {
      expect(redactUrl(`${token}\n${bot}\n${apiKey}\n${digest}\n${aws4}\n${lower}\n${quotedBearer}`)).not.toContain(
        secret
      );
    }
  });

  it("leaves the text in place when the key is empty", () => {
    expect(redactUrl("keep-this", "")).toBe("keep-this");
    expect(redactUrl("https://ssl.bing.com/x?apikey=abc&b=1", "")).toBe(
      "https://ssl.bing.com/x?apikey=[REDACTED]&b=1"
    );
    expect(redactError(new Error("keep-this"), "").message).toBe("keep-this");
  });
});

describe("redactCause", () => {
  it("stringifies a non-error cause and redacts the key", () => {
    const key = "secret/key 9f3a";
    const error = new Error("boom", {
      cause: { note: key, encoded: encodeURIComponent(key) },
    });
    const redacted = redactError(error, key);
    expect(typeof redacted.cause).toBe("string");
    const cause = String(redacted.cause);
    expect(cause).not.toContain(key);
    expect(cause).not.toContain(encodeURIComponent(key));
    expect(cause).toContain("[REDACTED]");
  });

  it("redacts a key that JSON escapes inside a cause", () => {
    const key = 'se"cret/key';
    const redacted = redactError(new Error("boom", { cause: { note: key } }), key);
    expect(redacted.cause).toBe('{"note":"[REDACTED]"}');
  });

  it("drops a cause that cannot be stringified", () => {
    const key = "secret/key 9f3a";
    const cause: { self?: unknown; key: string } = { key };
    cause.self = cause;
    const redacted = redactError(new Error(`boom ${key}`, { cause }), key);
    expect(redacted.cause).toBeUndefined();
    expect(redacted.message).not.toContain(key);
  });

  it("stops when an error is its own cause", () => {
    const key = "secret/key 9f3a";
    const error = new Error(`boom ${key}`);
    error.stack = `Error: boom ${key}`;
    error.cause = error;
    const redacted = redactError(error, key);
    expect(redacted.message).not.toContain(key);
    expect(redacted.stack).not.toContain(key);
    expect(redacted.cause).toBeInstanceOf(Error);
    if (!(redacted.cause instanceof Error)) return;
    expect(redacted.cause).not.toBe(redacted);
    expect(redacted.cause.cause).toBeUndefined();
    expect(redacted.cause.message).not.toContain(key);
    expect(redacted.cause.stack).not.toContain(key);
  });

  it("stops a cause chain at eight errors", () => {
    const key = "secret/key 9f3a";
    let current = new Error(`level-0 ${key}`);
    for (let level = 1; level < 20; level += 1) {
      current = new Error(`level-${level} ${key}`, { cause: current });
    }
    const redacted = redactError(current, key);
    const seen = new Set<unknown>();
    let length = 0;
    let cursor: unknown = redacted;
    while (cursor instanceof Error) {
      expect(seen.has(cursor)).toBe(false);
      seen.add(cursor);
      expect(cursor.message).not.toContain(key);
      cursor = cursor.cause;
      length += 1;
    }
    expect(length).toBe(8);
  });

  it("drops a BigInt cause", () => {
    const key = "secret/key 9f3a";
    const redacted = redactError(new Error(`boom ${key}`, { cause: BigInt(10) }), key);
    expect(redacted.cause).toBeUndefined();
    expect(redacted.message).not.toContain(key);
    const nested = redactError(new Error("boom", { cause: { note: key, n: BigInt(1) } }), key);
    expect(nested.cause).toBeUndefined();
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

  it("redacts a nested cause.cause", async () => {
    const key = "secret/key 9f3a";
    const encoded = encodeURIComponent(key);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const requested = String(input);
        const inner = new Error(`inner ${key} ${encoded} ${requested}`);
        inner.stack = `Error: inner ${key} ${encoded}\n    at inner (${requested})`;
        const mid = new Error(`mid ${key} ${encoded}`, { cause: inner });
        mid.stack = `Error: mid ${key} ${encoded}`;
        const error = new TypeError(`fetch failed ${requested}`, { cause: mid });
        error.stack = `TypeError: fetch failed ${requested}`;
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
    expect(caught.message).not.toContain(encoded);
    const mid = caught.cause;
    expect(mid).toBeInstanceOf(Error);
    if (!(mid instanceof Error)) return;
    expect(mid.message).not.toContain(key);
    expect(mid.stack).not.toContain(encoded);
    const inner = mid.cause;
    expect(inner).toBeInstanceOf(Error);
    if (!(inner instanceof Error)) return;
    expect(inner.message).not.toContain(key);
    expect(inner.message).not.toContain(encoded);
    expect(inner.stack).not.toContain(key);
    expect(inner.stack).not.toContain(encoded);
    expect(inner.message).toContain("apikey=[REDACTED]");
  });

  it("redacts an AggregateError and a non-error entry", async () => {
    const key = "secret/key 9f3a";
    const encoded = encodeURIComponent(key);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const child = new Error(`child ${key} ${encoded}`);
        child.stack = `Error: child ${key}\n    at child (${encoded})`;
        const mid = new Error(`mid ${key}`, { cause: child });
        mid.stack = `Error: mid ${encoded}`;
        const aggregate = new AggregateError(
          [mid, { note: key, encoded }],
          `aggregate ${key} ${encoded}`
        );
        aggregate.stack = `AggregateError: aggregate ${key}\n    at fetch (${encoded})`;
        throw aggregate;
      })
    );

    let caught: unknown;
    try {
      await fetchBingTraffic(key, "https://a.example/");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    if (!(caught instanceof AggregateError)) return;
    expect(caught.message).not.toContain(key);
    expect(caught.message).not.toContain(encoded);
    expect(caught.stack).not.toContain(key);
    expect(caught.stack).not.toContain(encoded);
    const mid = caught.errors[0];
    expect(mid).toBeInstanceOf(Error);
    if (!(mid instanceof Error)) return;
    expect(mid.message).not.toContain(key);
    expect(mid.stack).not.toContain(encoded);
    const child = mid.cause;
    expect(child).toBeInstanceOf(Error);
    if (!(child instanceof Error)) return;
    expect(child.message).not.toContain(key);
    expect(child.stack).not.toContain(encoded);
    expect(typeof caught.errors[1]).toBe("string");
    expect(String(caught.errors[1])).not.toContain(key);
    expect(String(caught.errors[1])).not.toContain(encoded);
  });
});

describe("a Bing error response", () => {
  it("strips the key from a non-OK JSON body", async () => {
    const key = "secret/key 9f3a";
    const encoded = encodeURIComponent(key);
    const queried = new URLSearchParams({ apikey: key }).toString().slice("apikey=".length);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ErrorCode: 3,
              Message: `rejected ${key} and ${encoded} and ${queried}`,
            }),
            { status: 401 }
          )
      )
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
    expect(caught.message).not.toContain(encoded);
    expect(caught.message).not.toContain(queried);
    expect(caught.stack).not.toContain(key);
    expect(caught.stack).not.toContain(encoded);
    expect(caught.stack).not.toContain(queried);
    expect(caught.message).toContain("[REDACTED]");
  });

  it("caps a JSON Message at 300 characters", async () => {
    const key = "secret/key 9f3a";
    const marker = "TAIL-MARKER-SHOULD-BE-CUT";
    const message = `${key}${"y".repeat(400)}${marker}${key}`;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ErrorCode: 1, Message: message }), { status: 400 })
      )
    );

    let caught: unknown;
    try {
      await fetchBingTraffic(key, "https://a.example/");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    if (!(caught instanceof Error)) return;
    const prefix = "Bing GetRankAndTrafficStats failed: 400 ";
    expect(caught.message.startsWith(prefix)).toBe(true);
    expect(caught.message.length - prefix.length).toBeLessThanOrEqual(300);
    expect(caught.message).not.toContain(key);
    expect(caught.message).not.toContain(marker);
  });

  it("strips the key from a non-OK plain body", async () => {
    const key = "secret/key 9f3a";
    const encoded = encodeURIComponent(key);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(`plain ${key} ${encoded}`, { status: 500 }))
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
    expect(caught.message).not.toContain(encoded);
    expect(caught.stack).not.toContain(key);
    expect(caught.stack).not.toContain(encoded);
  });
});

describe("an error class after redaction", () => {
  it("keeps BingKeyMissingError and TimeoutError", () => {
    const missing = redactError(new BingKeyMissingError());
    expect(missing).toBeInstanceOf(BingKeyMissingError);
    expect(missing.name).toBe("BingKeyMissingError");

    const key = "secret/key 9f3a";
    const timeout = new DOMException(`aborted ${key}`, "TimeoutError");
    timeout.stack = `TimeoutError: aborted ${key}`;
    const redacted = redactError(timeout, key);
    expect(redacted).toBeInstanceOf(DOMException);
    expect(redacted.name).toBe("TimeoutError");
    expect(redacted.message).not.toContain(key);
    expect(redacted.stack).not.toContain(key);
  });
});

describe("testBingKey", () => {
  it("returns false when the request fails", async () => {
    const key = "secret/key 9f3a";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(key);
      })
    );
    try {
      expect(await testBingKey(key)).toBe(false);
      const logged = spy.mock.calls.flat().map((part) => String(part)).join("\n");
      expect(logged).not.toContain(key);
      expect(logged).not.toContain(encodeURIComponent(key));
    } finally {
      spy.mockRestore();
    }
  });
});
