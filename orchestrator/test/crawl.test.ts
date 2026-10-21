import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CrawlDomainDeniedError, LiveOriginDeniedError } from "../src/allowlist";
import { crawlOrigins, LIVE_ORIGINS, MAX_BODY, normalizeUrl, ResponseTooLargeError } from "../src/autopilot/crawl";
import { loadFixtureSite } from "../src/autopilot/fixture-site";
import { extractHtml } from "../src/autopilot/html-page";
import { parseRobots, robotsAllows, robotsCrawlDelay } from "../src/autopilot/robots";
import { safeRequest, USER_AGENT, UnsafeMethodError } from "../src/autopilot/safe-http";

const ENV = { CRAWL_ALLOWED_DOMAINS: "bezkolejki.org,eurekalb.com" };
const FIXTURE = join(import.meta.dirname, "../fixtures/autopilot/site");

describe("html extract", () => {
  it("reads title, description, canonical, h1, noindex, and absolute links", () => {
    const page = extractHtml(
      '<html><head><title>  Hi &amp; Co </title><meta name=description content="Short">' +
        '<meta name="robots" content="noindex"><link rel="canonical" href="/here"></head>' +
        '<body><h1>One</h1><h1></h1><a href="/a">A</a><a href="mailto:a@b.c">m</a>' +
        '<a href="https://evil.example/x">x</a></body></html>',
      "https://eurekalb.com/start",
      null
    );
    expect(page.title).toBe("Hi & Co");
    expect(page.metaDescription).toBe("Short");
    expect(page.canonical).toBe("https://eurekalb.com/here");
    expect(page.h1).toEqual(["One"]);
    expect(page.noindex).toBe(true);
    expect(page.links).toEqual(["https://eurekalb.com/a", "https://evil.example/x"]);
  });
});

describe("robots", () => {
  const text = [
    "User-agent: *",
    "Disallow: /",
    "Allow: /public",
    "Crawl-delay: 1",
    "",
    "User-agent: SEOAutopilotBot",
    "Disallow: /private",
    "Crawl-delay: 5",
    "",
    "Sitemap: https://eurekalb.com/sitemap.xml",
  ].join("\n");

  it("prefers the bot group, the longest path, and Allow on a tie", () => {
    const parsed = parseRobots(text);
    expect(parsed.sitemaps).toEqual(["https://eurekalb.com/sitemap.xml"]);
    expect(robotsCrawlDelay(parsed, USER_AGENT)).toBe(5);
    expect(robotsAllows(parsed, "https://eurekalb.com/private", USER_AGENT)).toBe(false);
    expect(robotsAllows(parsed, "https://eurekalb.com/public", USER_AGENT)).toBe(true);
    expect(robotsAllows(parseRobots("User-agent: *\nDisallow: /\nAllow: /\n"), "https://eurekalb.com/", USER_AGENT)).toBe(
      true
    );
  });

  it("keeps the group across a comment and still splits on a blank line", () => {
    const commented = parseRobots("User-agent: *\n# x\nDisallow: /x\n");
    expect(robotsAllows(commented, "https://eurekalb.com/x", USER_AGENT)).toBe(false);
    expect(robotsAllows(commented, "https://eurekalb.com/ok", USER_AGENT)).toBe(true);
    const split = parseRobots("User-agent: *\nDisallow: /private\n\nAllow: /private\n");
    expect(robotsAllows(split, "https://eurekalb.com/private", USER_AGENT)).toBe(false);
  });
});

describe("polite crawl", () => {
  it("limits live origins to the two Eureka hosts", () => {
    expect(LIVE_ORIGINS).toEqual(["https://bezkolejki.org", "https://eurekalb.com"]);
  });

  it("refuses any method other than GET or HEAD and strips credentials", async () => {
    let called = false;
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      called = true;
      const headers = new Headers(init?.headers);
      expect(init?.method).toBe("GET");
      expect(init?.credentials).toBe("omit");
      expect(init?.redirect).toBe("manual");
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("cookie")).toBeNull();
      expect(headers.get("user-agent")).toBe(USER_AGENT);
      return new Response("ok");
    };
    await safeRequest(fetchImpl, "https://eurekalb.com/", {
      method: "GET",
      headers: { authorization: "Bearer secret", cookie: "session=1" },
    });
    expect(called).toBe(true);
    await expect(safeRequest(fetchImpl, "https://eurekalb.com/", { method: "POST" })).rejects.toBeInstanceOf(
      UnsafeMethodError
    );
    await expect(safeRequest(async () => new Response("no"), "https://eurekalb.com/", { method: "HEAD" })).resolves.toBeInstanceOf(
      Response
    );
  });

  it("crawls the fixture with robots, sitemap coverage, and no off-site fetches", async () => {
    const site = loadFixtureSite(FIXTURE);
    const [report] = await crawlOrigins({
      origins: [site.origin],
      fetchImpl: site.fetchImpl,
      env: ENV,
      minDelayMs: 0,
      sleep: async () => undefined,
    });
    expect(report?.robotsOutcome).toBe("rules");
    expect(report?.blockedByRobots).toContain("https://eurekalb.com/private");
    expect(report?.skippedOffHost).toContain("https://evil.example/phish");
    expect(site.calls.every((call) => call.method === "GET")).toBe(true);
    expect(site.calls.some((call) => call.url.includes("evil.example"))).toBe(false);
    expect(site.calls.some((call) => call.url.includes("/private"))).toBe(false);
    expect(report?.redirects).toEqual([{ from: "https://eurekalb.com/old", to: "https://eurekalb.com/about", status: 301 }]);
    expect(report?.brokenLinks).toEqual([
      { from: "https://eurekalb.com/", to: "https://eurekalb.com/missing", status: 404 },
    ]);
    expect(report?.sitemapUrls).toContain("https://eurekalb.com/ghost");
    const about = report?.pages.find((page) => page.url === "https://eurekalb.com/about");
    expect(about).toMatchObject({ title: "About", metaDescription: null, canonical: null, h1: [], status: 200 });
    const home = report?.pages.find((page) => page.url === "https://eurekalb.com/");
    expect(home?.h1).toEqual(["Eureka Labs"]);
    expect(report?.pages.find((page) => page.url === "https://eurekalb.com/noindex")?.noindex).toBe(true);
  });

  it("waits out a crawl-delay, skips a long delay, and treats robots 503 as unreachable", async () => {
    const waits: number[] = [];
    const delayed = await crawlOrigins({
      origins: ["https://bezkolejki.org"],
      env: ENV,
      minDelayMs: 0,
      sleep: async (ms) => {
        waits.push(ms);
      },
      fetchImpl: async (url) => {
        const path = new URL(url).pathname;
        if (path === "/robots.txt") {
          return new Response("User-agent: *\nCrawl-delay: 2\nDisallow:\n", { status: 200 });
        }
        if (path === "/sitemap.xml") return new Response("missing", { status: 404 });
        return new Response("<html><title>Home</title><h1>Home</h1></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      },
    });
    expect(delayed[0]?.crawlDelaySeconds).toBe(2);
    expect(waits.every((ms) => ms === 2000)).toBe(true);
    expect(waits.length).toBeGreaterThan(0);

    const methods: string[] = [];
    const skipped = await crawlOrigins({
      origins: ["https://eurekalb.com"],
      env: ENV,
      minDelayMs: 0,
      sleep: async () => undefined,
      fetchImpl: async (_url, init) => {
        methods.push((init?.method ?? "GET").toUpperCase());
        return new Response("User-agent: *\nCrawl-delay: 61\n", { status: 200 });
      },
    });
    expect(skipped[0]?.robotsOutcome).toBe("delay-too-long");
    expect(skipped[0]?.pages).toEqual([]);
    expect(methods).toEqual(["GET"]);

    const down = await crawlOrigins({
      origins: ["https://eurekalb.com"],
      env: ENV,
      minDelayMs: 0,
      sleep: async () => undefined,
      fetchImpl: async () => new Response("down", { status: 503 }),
    });
    expect(down[0]?.robotsOutcome).toBe("unreachable");
    expect(down[0]?.requests).toHaveLength(1);
  });

  it("does not fetch a host outside the allowlist", async () => {
    let called = false;
    await expect(
      crawlOrigins({
        origins: ["https://example.com"],
        env: ENV,
        fetchImpl: async () => {
          called = true;
          return new Response("no");
        },
      })
    ).rejects.toBeInstanceOf(CrawlDomainDeniedError);
    expect(called).toBe(false);
    expect(normalizeUrl("https://eurekalb.com/about/")).toBe("https://eurekalb.com/about");
  });

  it("skips a bad sitemap loc and a bad redirect without aborting the crawl", async () => {
    const fetched: string[] = [];
    const [report] = await crawlOrigins({
      origins: ["https://eurekalb.com"],
      env: ENV,
      minDelayMs: 0,
      sleep: async () => undefined,
      fetchImpl: async (url) => {
        fetched.push(url);
        const path = new URL(url).pathname;
        if (path === "/robots.txt") return new Response("User-agent: *\nDisallow:\n", { status: 200 });
        if (path === "/sitemap.xml") {
          return new Response(
            "<urlset><loc>https://eurekalb.com/</loc><loc>not a url</loc><loc>https://eurekalb.com/jump</loc><loc>https://eurekalb.com/next</loc></urlset>",
            { status: 200, headers: { "content-type": "application/xml" } }
          );
        }
        if (path === "/jump") {
          return new Response("", { status: 302, headers: { location: "http://" } });
        }
        return new Response("<html><title>Ok</title><h1>Ok</h1></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      },
    });
    expect(report?.sitemapUrls).toEqual([
      "https://eurekalb.com/",
      "https://eurekalb.com/jump",
      "https://eurekalb.com/next",
    ]);
    expect(report?.pages.some((page) => page.url === "https://eurekalb.com/next")).toBe(true);
    expect(fetched).toContain("https://eurekalb.com/jump");
    expect(report?.pages.some((page) => page.url === "https://eurekalb.com/jump")).toBe(false);
  });

  it("rejects a declared or streamed body over the cap and does not return pages", async () => {
    await expect(
      crawlOrigins({
        origins: ["https://eurekalb.com"],
        env: ENV,
        minDelayMs: 0,
        sleep: async () => undefined,
        fetchImpl: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull() {
                throw new Error("body was read");
              },
            }),
            { status: 200, headers: { "content-type": "text/plain", "content-length": String(MAX_BODY + 1) } }
          ),
      })
    ).rejects.toThrow(`Content-Length ${MAX_BODY + 1} exceeds ${MAX_BODY}`);
    let pulled = 0;

    await expect(
      crawlOrigins({
        origins: ["https://eurekalb.com"],
        env: ENV,
        minDelayMs: 0,
        sleep: async () => undefined,
        fetchImpl: async () => {
          const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
              const size = 64 * 1024;
              pulled += size;
              if (pulled > MAX_BODY + size * 4) {
                controller.error(new Error("stream was not aborted"));
                return;
              }
              controller.enqueue(new Uint8Array(size));
            },
          });
          return new Response(stream, { status: 200, headers: { "content-type": "text/html" } });
        },
      })
    ).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(pulled).toBeLessThan(MAX_BODY + 64 * 1024 * 2);
  });

  it("fails the run on timeout and does not keep a page", async () => {
    const fetched: string[] = [];
    await expect(
      crawlOrigins({
        origins: ["https://eurekalb.com"],
        env: ENV,
        minDelayMs: 0,
        timeoutMs: 30,
        sleep: async () => undefined,
        fetchImpl: (url, init) => {
          fetched.push(url);
          return new Promise((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) {
              reject(new Error("missing abort signal"));
              return;
            }
            signal.addEventListener("abort", () => reject(signal.reason));
          });
        },
      })
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetched).toEqual(["https://eurekalb.com/robots.txt"]);
  });

  it("does not fetch a redirect to http or to a non-default port", async () => {
    const cases = ["http://eurekalb.com/insecure", "https://eurekalb.com:8443/other"];
    for (const target of cases) {
      const fetched: string[] = [];
      await expect(
        crawlOrigins({
          origins: ["https://eurekalb.com"],
          env: ENV,
          minDelayMs: 0,
          sleep: async () => undefined,
          fetchImpl: async (url) => {
            fetched.push(url);
            const path = new URL(url).pathname;
            if (path === "/robots.txt") return new Response("User-agent: *\nDisallow:\n", { status: 200 });
            if (path === "/sitemap.xml") return new Response("missing", { status: 404 });
            if (path === "/") {
              return new Response(null, { status: 302, headers: { location: target } });
            }
            return new Response("<html><title>No</title></html>", {
              status: 200,
              headers: { "content-type": "text/html" },
            });
          },
        })
      ).rejects.toBeInstanceOf(LiveOriginDeniedError);
      expect(fetched).not.toContain(target);
      expect(fetched.every((url) => new URL(url).origin === "https://eurekalb.com")).toBe(true);
    }
  });
});
