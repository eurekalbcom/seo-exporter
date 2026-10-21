const REDACTED = "[REDACTED]";

/**
 * Returned when redaction itself throws. Fixed text only: the catch path must
 * not read the original value, message, or stack.
 */
const REDACTION_FAILED = "Bing request failed";

/** A cause chain longer than this is cut off. `e.cause = e` is also cut by the WeakSet. */
const MAX_REDACT_DEPTH = 8;

/**
 * Longer names first. `key` is also a suffix of `apikey` and `x-api-key`, and
 * `token` / `secret` are suffixes of the longer names. Leftmost-longest is not
 * how alternation works, so the longer spelling has to be tried first.
 */
const SENSITIVE_NAMES = [
  "access_token",
  "refresh_token",
  "client_secret",
  "subscription-key",
  "x-api-key",
  "id_token",
  "api_key",
  "apikey",
  "password",
  "secret",
  "token",
  "code",
  "key",
].join("|");

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

function base64Encode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** UTF-16 code units, the form JSON and JavaScript emit as `\uXXXX`. */
function unicodeEscaped(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    out += `\\u${value.charCodeAt(i).toString(16).padStart(4, "0")}`;
  }
  return out;
}

function htmlNamed(value: string, apostrophe: "&#39;" | "&apos;"): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, apostrophe);
}

function htmlDecimal(value: string): string {
  let out = "";
  for (const ch of value) out += `&#${ch.codePointAt(0)};`;
  return out;
}

function htmlHex(value: string): string {
  let out = "";
  for (const ch of value) out += `&#x${(ch.codePointAt(0) ?? 0).toString(16)};`;
  return out;
}

function secretVariants(apiKey: string): string[] {
  const variants = new Set<string>();
  addVariant(variants, apiKey);
  addVariant(variants, encodeURIComponent(apiKey));
  addVariant(variants, encodeURI(apiKey));
  addVariant(variants, queryEncoded(apiKey));
  addVariant(variants, JSON.stringify(apiKey).slice(1, -1));
  const base64 = base64Encode(apiKey);
  addVariant(variants, base64);
  addVariant(variants, base64.replace(/\+/g, "-").replace(/\//g, "_"));
  addVariant(variants, base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
  addVariant(variants, unicodeEscaped(apiKey));
  addVariant(variants, htmlNamed(apiKey, "&#39;"));
  addVariant(variants, htmlNamed(apiKey, "&apos;"));
  addVariant(variants, htmlDecimal(apiKey));
  addVariant(variants, htmlHex(apiKey));
  return [...variants].sort((left, right) => right.length - left.length);
}

function escapeRegExp(secret: string): string {
  return secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Case-insensitive. An empty secret must not match between characters. */
function replaceLiteral(value: string, secret: string): string {
  if (secret.length === 0) return value;
  return value.replace(new RegExp(escapeRegExp(secret), "gi"), REDACTED);
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
  return value.replace(new RegExp(pattern, "gi"), REDACTED);
}

// Start of the string, whitespace, `;`, and the usual query/fragment markers.
// `:` is a separator as well as `=`, so `apikey: value` is covered.
const SENSITIVE_QUERY = new RegExp(
  `(^|[?&#;\\s])(${SENSITIVE_NAMES})(\\s*[:=]\\s*)([^&#\\s"'<>;]*)`,
  "gi"
);
const JSON_KEY = new RegExp(`\\\\?(["'])(${SENSITIVE_NAMES})\\\\?\\1\\s*:\\s*`, "gi");
const AUTHORIZATION_MARK = /authorization\\?["']?\s*:\\?\s*/gi;
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

/** Digest and AWS4 keep comma-separated `name=` pairs. Every other scheme runs to EOL. */
function authStopsAtComma(value: string, start: number): boolean {
  const scheme = /^[A-Za-z0-9][A-Za-z0-9._-]*/.exec(value.slice(start))?.[0]?.toLowerCase() ?? "";
  return scheme === "digest" || scheme === "aws4-hmac-sha256";
}

/**
 * End of an unquoted auth value. A comma ends it only for Digest and AWS4,
 * and only when the next piece is not another `name=` pair.
 */
function endOfAuthValue(value: string, start: number, stopAtComma: boolean): number {
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
    if (stopAtComma && ch === "," && !/^\s*[A-Za-z0-9_-]+=/.test(value.slice(i + 1))) return i;
  }
  return value.length;
}

/**
 * Any scheme, through the closing quote or the end of the line. Digest and
 * AWS4 may also stop at a comma that does not continue `name=` pairs.
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
      const escaped = value[openAt - 1] === "\\";
      const end = closingQuote(value, openAt + 1, quote, escaped);
      result += quote + REDACTED;
      if (end < value.length && value[end] === quote) {
        if (escaped && value[end - 1] === "\\") result += "\\";
        result += quote;
        cursor = end + 1;
      } else {
        cursor = end;
      }
      continue;
    }
    result += REDACTED;
    cursor = endOfAuthValue(value, openAt, authStopsAtComma(value, openAt));
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
    cursor = endOfAuthValue(value, after, false);
  }
  return result + value.slice(cursor);
}

/**
 * End of a `[` / `{` value. Quoted strings, including `\"`, do not change depth.
 * A newline inside the value is whitespace. An unclosed value stops at the end
 * of the input.
 */
function endOfJsonContainer(value: string, openAt: number): number {
  const limit = value.length;
  const stack: string[] = [];
  let quote = "";
  let escapedQuote = false;
  for (let i = openAt; i < limit; i++) {
    const ch = value[i];
    if (quote) {
      if (escapedQuote) {
        if (ch === "\\" && value[i + 1] === "\\" && value[i + 2] === quote) {
          i += 2;
          continue;
        }
        if (ch === "\\" && value[i + 1] === quote) {
          quote = "";
          i += 1;
          continue;
        }
        continue;
      }
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === "\\" && (value[i + 1] === '"' || value[i + 1] === "'")) {
      quote = value[i + 1];
      escapedQuote = true;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      escapedQuote = false;
      continue;
    }
    if (ch === "[" || ch === "{") {
      stack.push(ch === "[" ? "]" : "}");
      continue;
    }
    if ((ch === "]" || ch === "}") && stack[stack.length - 1] === ch) {
      stack.pop();
      if (stack.length === 0) return i + 1;
    }
  }
  return limit;
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
      let end = i;
      if (quote === "[" || quote === "{") {
        end = endOfJsonContainer(value, i);
      } else {
        while (
          end < value.length &&
          value[end] !== "," &&
          value[end] !== "}" &&
          value[end] !== "\n"
        ) {
          end += 1;
        }
      }
      result += value.slice(cursor, i) + REDACTED;
      cursor = end;
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
 * and its encoded forms, including `%25xx`, base64, `\uXXXX`, HTML entities,
 * and `encodeURI`. Matching is case-insensitive. An empty key does not match
 * between characters.
 */
function redactUrlInner(value: string, apiKey?: string): string {
  let redacted = value;
  if (apiKey !== undefined && apiKey.length > 0) {
    for (const secret of secretVariants(apiKey)) {
      redacted = replaceSecret(redacted, secret);
    }
  }
  return redactBearer(
    redactAuthorization(redactJsonSecrets(redacted.replace(SENSITIVE_QUERY, `$1$2$3${REDACTED}`)))
  );
}

/** On any internal failure, a fixed string with none of `value`. */
export function redactUrl(value: string, apiKey?: string): string {
  try {
    return redactUrlInner(value, apiKey);
  } catch {
    return REDACTION_FAILED;
  }
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

function failedRedaction(): Error {
  try {
    const failure = new Error(REDACTION_FAILED);
    failure.stack = REDACTION_FAILED;
    return failure;
  } catch {
    return new Error(REDACTION_FAILED);
  }
}

/**
 * Copies an error with `redactUrl` applied to message, stack, and cause.
 * On any internal failure, a new error whose message and stack are the fixed
 * text and which does not carry the original cause.
 */
export function redactError(error: unknown, apiKey?: string): Error {
  try {
    return redactErrorLimited(error, apiKey, new WeakSet(), 0);
  } catch {
    return failedRedaction();
  }
}
