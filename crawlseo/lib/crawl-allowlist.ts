export class CrawlDomainDeniedError extends Error {
  readonly domain: string;

  constructor(domain: string) {
    super(`Domain is not on CRAWL_ALLOWED_DOMAINS: ${domain}`);
    this.name = "CrawlDomainDeniedError";
    this.domain = domain;
  }
}

/**
 * Hostname only. A query, fragment, or userinfo that merely ends with an
 * allowlisted suffix must not pass. Parse failure is an empty host, which
 * the allowlist denies.
 */
function normalizeHost(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let hostname: string;
  try {
    hostname = new URL(candidate).hostname;
  } catch {
    return "";
  }
  hostname = hostname.toLowerCase().replace(/\.$/, "");
  hostname = hostname.replace(/^www\./, "");
  return hostname;
}

/** Unset or empty denies every domain. There is no built-in allowlist. */
export function crawlAllowedDomains(): string[] {
  const raw = process.env.CRAWL_ALLOWED_DOMAINS;
  if (raw === undefined || raw.trim() === "") return [];
  return raw
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
