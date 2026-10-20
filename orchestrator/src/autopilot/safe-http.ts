export const USER_AGENT = "SEOAutopilotBot/0.1 (+https://eurekalb.com/bot)";
export const REQUEST_TIMEOUT_MS = 15_000;

export class UnsafeMethodError extends Error {
  constructor(method: string, url: string) {
    super(`Refusing unsafe HTTP method ${method} for ${url}`);
    this.name = "UnsafeMethodError";
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const SAFE_METHODS = new Set(["GET", "HEAD"]);

export async function safeRequest(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit = {},
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  if (!SAFE_METHODS.has(method)) throw new UnsafeMethodError(method, url);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Request timeout must be positive");
  const headers = new Headers(init.headers);
  headers.delete("authorization");
  headers.delete("cookie");
  headers.delete("proxy-authorization");
  headers.set("user-agent", USER_AGENT);
  headers.set("accept", headers.get("accept") ?? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return fetchImpl(url, {
    method,
    headers,
    redirect: "manual",
    credentials: "omit",
    signal,
  });
}
