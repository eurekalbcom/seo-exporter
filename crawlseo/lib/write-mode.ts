const MUTATING_METHODS = new Set(["PUT", "PATCH", "DELETE"]);

export class WriteDisabledError extends Error {
  constructor(target: string) {
    super(`WRITE_MODE is off; refused external write to ${target}`);
    this.name = "WriteDisabledError";
  }
}

export type WriteMode = "off" | "on";

/** Default off. Only the exact value "on" arms external writes (EUR-406). */
export function writeMode(): WriteMode {
  return process.env.WRITE_MODE?.trim().toLowerCase() === "on" ? "on" : "off";
}

function hostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * PUT, PATCH, and DELETE to any non-local host are external writes.
 * Search Console query calls are POST and stay allowed: they do not mutate
 * the property. Relative URLs (this app's own API) are not external.
 */
export function isBlockedExternalWrite(method: string, url: string): boolean {
  if (writeMode() === "on") return false;
  if (!MUTATING_METHODS.has(method.toUpperCase())) return false;
  const host = hostname(url);
  if (!host) return false;
  return !isLocalHost(host);
}

export function assertExternalWriteAllowed(method: string, url: string): void {
  if (isBlockedExternalWrite(method, url)) {
    throw new WriteDisabledError(url);
  }
}

type FetchFn = typeof fetch;

let installed = false;
let originalFetch: FetchFn | null = null;

/** One process-wide guard. Idempotent. */
export function installFetchGuard(): void {
  if (installed) return;
  originalFetch = globalThis.fetch.bind(globalThis);
  const base = originalFetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    assertExternalWriteAllowed(method, url);
    return base(input, init);
  }) as FetchFn;
  installed = true;
}

export function uninstallFetchGuard(): void {
  if (originalFetch) globalThis.fetch = originalFetch;
  originalFetch = null;
  installed = false;
}
