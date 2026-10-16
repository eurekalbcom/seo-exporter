import { afterEach, describe, expect, it } from "vitest";
import { isCrawlDomainAllowed } from "./crawl-allowlist";

const ALLOWED = "allowed.pl";

afterEach(() => {
  delete process.env.CRAWL_ALLOWED_DOMAINS;
});

describe("crawl allowlist host parsing", () => {
  it("rejects a fragment that looks like userinfo and a glued suffix", () => {
    process.env.CRAWL_ALLOWED_DOMAINS = ALLOWED;
    expect(isCrawlDomainAllowed("evil.com#@allowed.pl")).toBe(false);
    expect(isCrawlDomainAllowed("https://evil.com#@allowed.pl")).toBe(false);
    expect(isCrawlDomainAllowed("https://allowed.pl#@evil.com")).toBe(true);

    process.env.CRAWL_ALLOWED_DOMAINS = "eurekalb.com";
    expect(isCrawlDomainAllowed("evileurekalb.com")).toBe(false);
    expect(isCrawlDomainAllowed("eurekalb.com")).toBe(true);
    expect(isCrawlDomainAllowed("www.eurekalb.com")).toBe(true);
    expect(isCrawlDomainAllowed("a.eurekalb.com")).toBe(true);
    expect(isCrawlDomainAllowed("eurekalb.com.evil.com")).toBe(false);
  });

  it("compares IDN names as punycode and rejects a homograph", () => {
    process.env.CRAWL_ALLOWED_DOMAINS = "münchen.de";
    expect(isCrawlDomainAllowed("https://münchen.de")).toBe(true);
    expect(isCrawlDomainAllowed("https://xn--mnchen-3ya.de")).toBe(true);
    expect(isCrawlDomainAllowed("https://www.münchen.de/path")).toBe(true);
    expect(isCrawlDomainAllowed("https://notmünchen.de")).toBe(false);

    process.env.CRAWL_ALLOWED_DOMAINS = "xn--mnchen-3ya.de";
    expect(isCrawlDomainAllowed("https://münchen.de")).toBe(true);

    process.env.CRAWL_ALLOWED_DOMAINS = "eurekalb.com";
    expect(isCrawlDomainAllowed("https://еurekalb.com")).toBe(false);
  });

  it("ignores the port and matches an IP only exactly", () => {
    process.env.CRAWL_ALLOWED_DOMAINS = "allowed.pl";
    expect(isCrawlDomainAllowed("https://allowed.pl:8443/path")).toBe(true);
    expect(isCrawlDomainAllowed("allowed.pl:8443")).toBe(true);
    expect(isCrawlDomainAllowed("https://evil.com:443")).toBe(false);
    expect(isCrawlDomainAllowed("http://127.0.0.1:8080")).toBe(false);
    expect(isCrawlDomainAllowed("http://[::1]:80/")).toBe(false);
    expect(isCrawlDomainAllowed("http://2130706433")).toBe(false);
    expect(isCrawlDomainAllowed("https://93.184.216.34:443")).toBe(false);

    process.env.CRAWL_ALLOWED_DOMAINS = "93.184.216.34";
    expect(isCrawlDomainAllowed("https://93.184.216.34:443/x")).toBe(true);
    expect(isCrawlDomainAllowed("93.184.216.34")).toBe(true);
    expect(isCrawlDomainAllowed("https://93.184.216.35")).toBe(false);
    expect(isCrawlDomainAllowed("https://9.93.184.216.34")).toBe(false);
    expect(isCrawlDomainAllowed("https://93.184.216.34.evil.com")).toBe(false);

    process.env.CRAWL_ALLOWED_DOMAINS = "184.216.34";
    expect(isCrawlDomainAllowed("https://93.184.216.34")).toBe(false);

    process.env.CRAWL_ALLOWED_DOMAINS = "[::1]";
    expect(isCrawlDomainAllowed("http://[::1]:8080/")).toBe(true);
    expect(isCrawlDomainAllowed("http://[::2]/")).toBe(false);

    process.env.CRAWL_ALLOWED_DOMAINS = "127.0.0.1";
    expect(isCrawlDomainAllowed("http://2130706433")).toBe(true);
    expect(isCrawlDomainAllowed("http://127.0.0.1:9")).toBe(true);
    expect(isCrawlDomainAllowed("http://127.0.0.2")).toBe(false);
  });
});
