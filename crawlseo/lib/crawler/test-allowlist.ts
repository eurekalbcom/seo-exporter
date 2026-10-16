import { afterEach, beforeEach } from "vitest";

/** Hosts the crawler unit tests fetch. Subdomains of these names are allowed too. */
export const CRAWLER_TEST_DOMAINS = [
  "example.com",
  "quilltab.app",
  "dead.invalid",
  "a.example",
  "dual.example",
  "mixed.example",
  "x.com",
  "eurekalb.com",
].join(",");

/** Pins CRAWL_ALLOWED_DOMAINS for a crawler test file and restores it afterwards. */
export function allowCrawlerTestDomains(): void {
  const previous = process.env.CRAWL_ALLOWED_DOMAINS;
  beforeEach(() => {
    process.env.CRAWL_ALLOWED_DOMAINS = CRAWLER_TEST_DOMAINS;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.CRAWL_ALLOWED_DOMAINS;
    else process.env.CRAWL_ALLOWED_DOMAINS = previous;
  });
}
