export const DEFAULT_CRAWL_ALLOWED_DOMAINS = ["bezkolejki.org", "eurekalb.com"] as const;

export class CrawlDomainDeniedError extends Error {
  constructor(domain: string) {
    super(`Domain is not on CRAWL_ALLOWED_DOMAINS: ${domain}`);
    this.name = "CrawlDomainDeniedError";
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

export function crawlAllowedDomains(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.CRAWL_ALLOWED_DOMAINS;
  const source = raw === undefined ? DEFAULT_CRAWL_ALLOWED_DOMAINS.join(",") : raw;
  return source
    .split(",")
    .map((domain) => normalizeHost(domain))
    .filter(Boolean);
}

export function assertCrawlDomainAllowed(domain: string, env: NodeJS.ProcessEnv = process.env): void {
  const host = normalizeHost(domain);
  const allowed = crawlAllowedDomains(env);
  const ok = allowed.some((entry) => host === entry || host.endsWith(`.${entry}`));
  if (!ok) throw new CrawlDomainDeniedError(domain);
}
