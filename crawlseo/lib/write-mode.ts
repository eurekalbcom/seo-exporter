import { Agent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Non-safe methods are allowed only when the host and path match one of these
 * Google read calls. POST /webmasters/v3/sites (add a property) is not here.
 * Search Analytics query and URL Inspection are reads that Google exposes as POST.
 */
const GOOGLE_READS: Array<{ host: string; method: string; path: RegExp }> = [
  { host: "oauth2.googleapis.com", method: "POST", path: /^\/token$/ },
  { host: "www.googleapis.com", method: "GET", path: /^\/webmasters\/v3\/sites(?:\/|$)/ },
  {
    host: "www.googleapis.com",
    method: "POST",
    path: /^\/webmasters\/v3\/sites\/[^/]+\/searchAnalytics\/query$/,
  },
  { host: "www.googleapis.com", method: "GET", path: /^\/pagespeedonline\/v5\/runPagespeed$/ },
  { host: "searchconsole.googleapis.com", method: "POST", path: /^\/v1\/urlInspection\/index:inspect$/ },
];

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

function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/** True when this host, method, and path are a known Google read. */
export function isGoogleRead(method: string, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const upper = method.toUpperCase();
  return GOOGLE_READS.some((rule) => rule.host === host && rule.method === upper && rule.path.test(parsed.pathname));
}

/**
 * WRITE_MODE=off allows safe methods, this app's own host, and the Google
 * read allowlist. Every other method, including POST to Bing SubmitUrl, is
 * refused. WRITE_MODE=on does not add write endpoints; it only lifts this guard.
 */
export function isBlockedExternalWrite(method: string, url: string): boolean {
  if (writeMode() === "on") return false;
  const upper = method.toUpperCase();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (isLocalHost(parsed.hostname.toLowerCase())) return false;
  if (SAFE_METHODS.has(upper)) return false;
  return !isGoogleRead(upper, url);
}

export function assertExternalWriteAllowed(method: string, url: string): void {
  if (isBlockedExternalWrite(method, url)) {
    throw new WriteDisabledError(url);
  }
}

function requestUrl(opts: Dispatcher.DispatchOptions): string {
  const origin = opts.origin instanceof URL ? opts.origin.origin : String(opts.origin ?? "");
  const path = String(opts.path ?? "/");
  const base = origin || "https://missing-origin.invalid";
  try {
    return new URL(path, base).toString();
  } catch {
    return `${base}${path}`;
  }
}

/** Undici dispatch interceptor. Covers fetch, undici.request, and libraries that use the global dispatcher. */
export function writeGuardInterceptor(): Dispatcher.DispatcherComposeInterceptor {
  return (dispatch) => (opts, handler) => {
    const method = String(opts.method ?? "GET");
    const url = requestUrl(opts);
    if (isBlockedExternalWrite(method, url)) {
      handler.onError?.(new WriteDisabledError(url));
      return false;
    }
    return dispatch(opts, handler);
  };
}

let installed = false;
let previous: Dispatcher | null = null;

/** One process-wide guard. Idempotent. */
export function installFetchGuard(): void {
  if (installed) return;
  previous = getGlobalDispatcher();
  setGlobalDispatcher(new Agent().compose(writeGuardInterceptor()));
  installed = true;
}

export function uninstallFetchGuard(): void {
  if (previous) setGlobalDispatcher(previous);
  previous = null;
  installed = false;
}
