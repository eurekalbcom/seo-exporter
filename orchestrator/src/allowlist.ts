export class CrawlDomainDeniedError extends Error {
  constructor(domain: string) {
    super(`Domain is not on CRAWL_ALLOWED_DOMAINS: ${domain}`);
    this.name = "CrawlDomainDeniedError";
  }
}

/** Same host parse as crawlseo/lib/crawl-allowlist.ts. Parse failure denies. */
function isIpHost(host: string): boolean {
  if (host.startsWith("[") && host.endsWith("]") && host.includes(":")) return true;
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

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
export function crawlAllowedDomains(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.CRAWL_ALLOWED_DOMAINS;
  if (raw === undefined || raw.trim() === "") return [];
  return raw
    .split(",")
    .map((domain) => normalizeHost(domain))
    .filter(Boolean);
}

export function assertCrawlDomainAllowed(domain: string, env: NodeJS.ProcessEnv = process.env): void {
  const host = normalizeHost(domain);
  const allowed = crawlAllowedDomains(env);
  const ok = Boolean(host) && allowed.some((entry) => hostMatches(host, entry));
  if (!ok) throw new CrawlDomainDeniedError(domain);
}
