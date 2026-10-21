import { assertCrawlDomainAllowed } from "./allowlist";

export type TriggerJob = "gsc-sync" | "crawl" | "vitals";

export type TriggerOptions = {
  baseUrl: string;
  token: string;
  job: TriggerJob;
  domain: string;
  fetchImpl?: typeof fetch;
};

/**
 * Hosts that may receive the orchestrator bearer token.
 * `app` is the compose service name in crawlseo/docker-compose.yml.
 * This list is fixed. It is not read from the environment.
 */
export const JOB_HOST_ALLOWLIST = ["localhost", "127.0.0.1", "app"] as const;

const JOB_HOSTS: ReadonlySet<string> = new Set(JOB_HOST_ALLOWLIST);

const JOB_PATH = "/api/internal/jobs";

export class JobTargetDeniedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "JobTargetDeniedError";
  }
}

function assertJobTarget(url: URL): void {
  if (url.username !== "" || url.password !== "") {
    throw new JobTargetDeniedError("Refusing job URL with userinfo");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new JobTargetDeniedError("Refusing non-http job URL");
  }
  if (!JOB_HOSTS.has(url.hostname)) {
    throw new JobTargetDeniedError("Refusing job URL host");
  }
}

/** Parse baseUrl and pin the request to the local jobs path. Fail closed. */
export function jobUrl(baseUrl: string): URL {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new JobTargetDeniedError("Refusing invalid job URL");
  }
  assertJobTarget(base);
  const url = new URL(JOB_PATH, base);
  assertJobTarget(url);
  if (url.origin !== base.origin || url.pathname !== JOB_PATH || url.search !== "" || url.hash !== "") {
    throw new JobTargetDeniedError("Refusing non-local job URL");
  }
  return url;
}

function isRedirect(response: Response): boolean {
  return response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400);
}

/** Calls the crawlseo adapter. The bearer token is sent only to an allowlisted host. */
export async function triggerJob(options: TriggerOptions): Promise<void> {
  const url = jobUrl(options.baseUrl);
  assertCrawlDomainAllowed(options.domain);
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(url, {
    method: "POST",
    redirect: "manual",
    headers: {
      authorization: `Bearer ${options.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ job: options.job, domain: options.domain }),
  });
  if (isRedirect(response)) {
    if (response.body) {
      await response.body.cancel().catch(() => undefined);
    }
    throw new JobTargetDeniedError("Refusing job redirect");
  }
  if (!response.ok) {
    throw new Error(`crawlseo job failed: ${response.status}`);
  }
}
