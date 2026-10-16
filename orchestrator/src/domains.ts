import { readFileSync } from "node:fs";
import { assertCrawlDomainAllowed } from "./allowlist";

export function parseDomainsYml(text: string): string[] {
  const domains: string[] = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^\s+-\s+([a-z0-9.-]+)\s*$/i);
    if (match?.[1]) domains.push(match[1].toLowerCase());
  }
  return domains;
}

export function loadScheduledDomains(path: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const domains = parseDomainsYml(readFileSync(path, "utf8"));
  for (const domain of domains) assertCrawlDomainAllowed(domain, env);
  return domains;
}
