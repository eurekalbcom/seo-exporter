export class CrawlDomainDeniedError extends Error {
  readonly domain: string;

  constructor(domain: string) {
    super(`Domain is not on CRAWL_ALLOWED_DOMAINS: ${domain}`);
    this.name = "CrawlDomainDeniedError";
    this.domain = domain;
  }
}

/** IPv4 dotted quad, or an IPv6 hostname as returned by URL (bracketed). */
function isIpHost(host: string): boolean {
  if (host.startsWith("[") && host.endsWith("]") && host.includes(":")) return true;
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * Hostname only. A query, fragment, userinfo, or lookalike suffix must not
 * pass. `host:port` is not a scheme. Parse failure is an empty host, which
 * the allowlist denies. IDN labels are compared as punycode.
 */
function normalizeHost(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
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

function hostMatches(host: string, entry: string): boolean {
  if (isIpHost(host) || isIpHost(entry)) return host === entry;
  return host === entry || host.endsWith(`.${entry}`);
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
  return allowed.some((entry) => hostMatches(host, entry));
}

export function assertCrawlDomainAllowed(domain: string): void {
  if (!isCrawlDomainAllowed(domain)) {
    throw new CrawlDomainDeniedError(domain);
  }
}
