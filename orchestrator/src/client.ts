import { assertCrawlDomainAllowed } from "./allowlist";

export type TriggerJob = "gsc-sync" | "crawl" | "vitals";

export type TriggerOptions = {
  baseUrl: string;
  token: string;
  job: TriggerJob;
  domain: string;
  fetchImpl?: typeof fetch;
};

/** Calls the crawlseo adapter. The URL is always the local jobs route. */
export async function triggerJob(options: TriggerOptions): Promise<void> {
  assertCrawlDomainAllowed(options.domain);
  const base = new URL(options.baseUrl);
  const url = new URL("/api/internal/jobs", base);
  if (url.origin !== base.origin) {
    throw new Error(`Refusing non-local URL: ${url.toString()}`);
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ job: options.job, domain: options.domain }),
  });
  if (!response.ok) {
    throw new Error(`crawlseo job failed: ${response.status}`);
  }
}
