export const USER_AGENT = "SEOAutopilotBot/0.1 (+https://eurekalb.com/bot)";

export class UnsafeMethodError extends Error {
  constructor(method: string, url: string) {
    super(`Refusing unsafe HTTP method ${method} for ${url}`);
    this.name = "UnsafeMethodError";
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const SAFE_METHODS = new Set(["GET", "HEAD"]);

export async function safeRequest(fetchImpl: FetchLike, url: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  if (!SAFE_METHODS.has(method)) throw new UnsafeMethodError(method, url);
  const headers = new Headers(init.headers);
  headers.delete("authorization");
  headers.delete("cookie");
  headers.delete("proxy-authorization");
  headers.set("user-agent", USER_AGENT);
  headers.set("accept", headers.get("accept") ?? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
  return fetchImpl(url, {
    method,
    headers,
    redirect: "manual",
    credentials: "omit",
    signal: init.signal,
  });
}
