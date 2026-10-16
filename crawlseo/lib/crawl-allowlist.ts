export const DEFAULT_CRAWL_ALLOWED_DOMAINS = ["bezkolejki.org", "eurekalb.com"] as const;

export class CrawlDomainDeniedError extends Error {
  readonly domain: string;

  constructor(domain: string) {
    super(`Domain is not on CRAWL_ALLOWED_DOMAINS: ${domain}`);
    this.name = "CrawlDomainDeniedError";
    this.domain = domain;
  }
}

function normalizeHost(value: string): string {
  let host = value.trim().toLowerCase();
  host = host.replace(/^https?:\/\//, "");
  host = host.split("/")[0] ?? "";
  host = host.replace(/:\d+$/, "");
  host = host.replace(/\.$/, "");
  host = host.replace(/^www\./, "");
  return host;
}

/** Unset uses the Eureka allowlist. An explicit empty value allows nothing. */
export function crawlAllowedDomains(): string[] {
  const raw = process.env.CRAWL_ALLOWED_DOMAINS;
  const source = raw === undefined ? DEFAULT_CRAWL_ALLOWED_DOMAINS.join(",") : raw;
  return source
    .split(",")
    .map((domain) => normalizeHost(domain))
    .filter(Boolean);
}

export function isCrawlDomainAllowed(domain: string, allowed = crawlAllowedDomains()): boolean {
  const host = normalizeHost(domain);
  if (!host) return false;
  return allowed.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

export function assertCrawlDomainAllowed(domain: string): void {
  if (!isCrawlDomainAllowed(domain)) {
    throw new CrawlDomainDeniedError(domain);
  }
}
