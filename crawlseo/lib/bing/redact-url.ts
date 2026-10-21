const REDACTED = "[REDACTED]";

/** A cause chain longer than this is cut off. `e.cause = e` is also cut by the WeakSet. */
const MAX_REDACT_DEPTH = 8;

/**
 * Query value as `URLSearchParams` writes it. That encoding uses `+` for a
 * space, which `encodeURIComponent` does not, so a body can echo either form.
 */
function queryEncoded(apiKey: string): string {
  return new URLSearchParams({ apikey: apiKey }).toString().slice("apikey=".length);
}

function addVariant(variants: Set<string>, value: string) {
  if (value.length === 0) return;
  variants.add(value);
  // `%2F` written again as `%252F`. Longer forms are replaced first.
  if (value.includes("%")) variants.add(value.replace(/%/g, "%25"));
}

function secretVariants(apiKey: string): string[] {
  const variants = new Set<string>();
  addVariant(variants, apiKey);
  addVariant(variants, encodeURIComponent(apiKey));
  addVariant(variants, queryEncoded(apiKey));
  addVariant(variants, JSON.stringify(apiKey).slice(1, -1));
  return [...variants].sort((left, right) => right.length - left.length);
}

function replaceLiteral(value: string, secret: string): string {
  if (secret.length === 0) return value;
  return value.split(secret).join(REDACTED);
}

function hexClass(hex: string): string {
  let out = "";
  for (const ch of hex) {
    out += /[A-Fa-f]/.test(ch) ? `[${ch.toUpperCase()}${ch.toLowerCase()}]` : ch;
  }
  return out;
}

/** `%2F` and `%2f` are the same octet, including the double-encoded `%252F`. */
function replaceSecret(value: string, secret: string): string {
  if (secret.length === 0) return value;
  if (!/%(?:25)?[0-9A-Fa-f]{2}/.test(secret)) return replaceLiteral(value, secret);
  const pattern = secret
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/%25[0-9A-Fa-f]{2}/g, (match) => `%25${hexClass(match.slice(3))}`)
    .replace(/%[0-9A-Fa-f]{2}/g, (match) => `%${hexClass(match.slice(1))}`);
  return value.replace(new RegExp(pattern, "g"), REDACTED);
}

const SENSITIVE_QUERY =
  /([?&#](?:access_token|refresh_token|client_secret|api_key|apikey|token)=)[^&#\s"'<>]*/gi;
const JSON_KEY =
  /\\?(["'])(access_token|refresh_token|client_secret|api_key|apikey|token)\\?\1\s*:\s*/gi;
const AUTHORIZATION_MARK = /authorization["']?\s*:\s*/gi;
const BEARER_MARK = /\bbearer\b/gi;

function closingQuote(value: string, start: number, quote: string, escaped: boolean): number {
  for (let i = start; i < value.length; i++) {
    if (!escaped && value[i] === "\\") {
      i += 1;
      continue;
    }
    if (escaped && value[i] === "\\" && value[i + 1] === "\\" && value[i + 2] === quote) {
      i += 2;
      continue;
    }
    if (escaped && value[i] === "\\" && value[i + 1] === quote) return i + 1;
    if (!escaped && value[i] === quote) return i;
  }
  return value.length;
}

/** A comma ends an unquoted header unless it continues `name=` pairs (Digest, AWS4). */
function endOfAuthValue(value: string, start: number): number {
  let quote = "";
  for (let i = start; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "\n") return i;
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "," && !/^\s*[A-Za-z0-9_-]+=/.test(value.slice(i + 1))) return i;
  }
  return value.length;
}

/**
 * Any scheme, through the closing quote, a comma that does not continue
 * `name=` pairs, or the end of the line.
 */
function redactAuthorization(value: string): string {
  let result = "";
  let cursor = 0;
  for (const match of value.matchAll(AUTHORIZATION_MARK)) {
    const index = match.index ?? 0;
    if (index < cursor) continue;
    const openAt = index + match[0].length;
    result += value.slice(cursor, openAt);
    if (value[openAt] === '"' || value[openAt] === "'") {
      const quote = value[openAt];
      const end = closingQuote(value, openAt + 1, quote, false);
      result += quote + REDACTED;
      if (end < value.length && value[end] === quote) {
        result += quote;
        cursor = end + 1;
      } else {
        cursor = end;
      }
      continue;
    }
    result += REDACTED;
    cursor = endOfAuthValue(value, openAt);
  }
  return result + value.slice(cursor);
}

function redactBearer(value: string): string {
  let result = "";
  let cursor = 0;
  for (const match of value.matchAll(BEARER_MARK)) {
    const index = match.index ?? 0;
    if (index < cursor) continue;
    const before = value[index - 1];
    result += value.slice(cursor, index) + match[0];
    const after = index + match[0].length;
    if (before === '"' || before === "'") {
      const end = closingQuote(value, after, before, false);
      result += " " + REDACTED;
      cursor = end;
      continue;
    }
    result += " " + REDACTED;
    cursor = endOfAuthValue(value, after);
  }
  return result + value.slice(cursor);
}

function redactJsonSecrets(value: string): string {
  let result = "";
  let cursor = 0;
  for (const match of value.matchAll(JSON_KEY)) {
    const index = match.index ?? 0;
    if (index < cursor) continue;
    let i = index + match[0].length;
    const escaped = value[i] === "\\";
    if (escaped) i += 1;
    const quote = value[i];
    if (quote !== '"' && quote !== "'") {
      result += value.slice(cursor, i);
      cursor = i;
      continue;
    }
    const end = closingQuote(value, i + 1, quote, escaped);
    result += value.slice(cursor, i) + quote + REDACTED;
    if (end < value.length && value[end] === quote) {
      if (escaped && value[end - 1] === "\\") result += "\\";
      result += quote;
      cursor = end + 1;
    } else {
      cursor = end;
    }
  }
  return result + value.slice(cursor);
}

/**
 * Replaces sensitive query values, JSON secrets, and `Authorization` /
 * `Bearer` headers. When `apiKey` is passed, also replaces that literal value
 * and its encoded forms, including `%25xx`. An empty key does not match
 * between characters.
 */
export function redactUrl(value: string, apiKey?: string): string {
  let redacted = value;
  if (apiKey !== undefined && apiKey.length > 0) {
    for (const secret of secretVariants(apiKey)) {
      redacted = replaceSecret(redacted, secret);
    }
  }
  return redactBearer(
    redactAuthorization(redactJsonSecrets(redacted.replace(SENSITIVE_QUERY, `$1${REDACTED}`)))
  );
}

function constructLike(error: Error, message: string, cause: unknown): Error {
  const options = cause === undefined ? undefined : { cause };
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    const copy = new DOMException(message, error.name);
    if (cause !== undefined) {
      Object.defineProperty(copy, "cause", { value: cause, configurable: true, writable: true });
    }
    return copy;
  }
  if (error instanceof AggregateError) {
    return new AggregateError([], message, options);
  }
  try {
    const Ctor = error.constructor as new (msg?: string, opts?: { cause?: unknown }) => Error;
    const copy = new Ctor(message, options);
    if (copy instanceof Error) return copy;
  } catch {
    // A custom constructor can reject the redacted arguments.
  }
  const fallback = new Error(message, options);
  Object.setPrototypeOf(fallback, Object.getPrototypeOf(error));
  return fallback;
}

function messageOnly(error: Error, apiKey?: string): Error {
  return copyRedacted(error, constructLike(error, redactUrl(error.message, apiKey), undefined), apiKey);
}

function redactCause(
  cause: unknown,
  apiKey: string | undefined,
  seen: WeakSet<object>,
  depth: number
): unknown {
  if (depth >= MAX_REDACT_DEPTH) return undefined;
  if (cause instanceof Error) {
    if (seen.has(cause)) return messageOnly(cause, apiKey);
    return redactErrorLimited(cause, apiKey, seen, depth);
  }
  if (typeof cause === "string") return redactUrl(cause, apiKey);
  if (typeof cause === "bigint") return undefined;
  try {
    const serialized = JSON.stringify(cause);
    if (typeof serialized !== "string") return undefined;
    return redactUrl(serialized, apiKey);
  } catch {
    return undefined;
  }
}

function copyRedacted<T extends Error>(error: Error, redacted: T, apiKey?: string): T {
  try {
    redacted.name = error.name;
  } catch {
    // DOMException.name is fixed when the copy is constructed.
  }
  if (typeof error.stack === "string") {
    redacted.stack = redactUrl(error.stack, apiKey);
  }
  return redacted;
}

function redactAggregate(
  error: AggregateError,
  apiKey: string | undefined,
  seen: WeakSet<object>,
  depth: number
): AggregateError {
  const errors: unknown[] = [];
  for (const item of error.errors) {
    const redacted =
      item instanceof Error
        ? redactErrorLimited(item, apiKey, seen, depth + 1)
        : redactCause(item, apiKey, seen, depth + 1);
    if (redacted !== undefined) errors.push(redacted);
  }
  const cause =
    error.cause === undefined ? undefined : redactCause(error.cause, apiKey, seen, depth + 1);
  return copyRedacted(
    error,
    new AggregateError(
      errors,
      redactUrl(error.message, apiKey),
      cause === undefined ? undefined : { cause }
    ),
    apiKey
  );
}

function redactErrorLimited(
  error: unknown,
  apiKey: string | undefined,
  seen: WeakSet<object>,
  depth: number
): Error {
  if (!(error instanceof Error)) {
    return new Error(redactUrl(String(error), apiKey));
  }
  if (depth >= MAX_REDACT_DEPTH || seen.has(error)) {
    return messageOnly(error, apiKey);
  }
  seen.add(error);
  if (error instanceof AggregateError) return redactAggregate(error, apiKey, seen, depth);
  const cause =
    error.cause === undefined ? undefined : redactCause(error.cause, apiKey, seen, depth + 1);
  return copyRedacted(
    error,
    constructLike(error, redactUrl(error.message, apiKey), cause),
    apiKey
  );
}

/** Copies an error with `redactUrl` applied to message, stack, and cause. */
export function redactError(error: unknown, apiKey?: string): Error {
  return redactErrorLimited(error, apiKey, new WeakSet(), 0);
}
