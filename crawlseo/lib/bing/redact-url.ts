const REDACTED = "[REDACTED]";

/**
 * Query value as `URLSearchParams` writes it. That encoding uses `+` for a
 * space, which `encodeURIComponent` does not, so a body can echo either form.
 */
function queryEncoded(apiKey: string): string {
  return new URLSearchParams({ apikey: apiKey }).toString().slice("apikey=".length);
}

function secretVariants(apiKey: string): string[] {
  const variants = new Set<string>();
  if (apiKey.length > 0) variants.add(apiKey);
  const encoded = encodeURIComponent(apiKey);
  if (encoded.length > 0) variants.add(encoded);
  const queried = queryEncoded(apiKey);
  if (queried.length > 0) variants.add(queried);
  const jsonEscaped = JSON.stringify(apiKey).slice(1, -1);
  if (jsonEscaped.length > 0) variants.add(jsonEscaped);
  return [...variants].sort((left, right) => right.length - left.length);
}

function replaceLiteral(value: string, secret: string): string {
  if (secret.length === 0) return value;
  return value.split(secret).join(REDACTED);
}

/**
 * Replaces every `apikey` query or fragment value. When `apiKey` is passed,
 * also replaces that literal value and its encoded forms, so a body that
 * echoes the key without an `apikey=` prefix is safe to log.
 */
export function redactUrl(value: string, apiKey?: string): string {
  let redacted = value;
  if (apiKey) {
    for (const secret of secretVariants(apiKey)) {
      redacted = replaceLiteral(redacted, secret);
    }
  }
  return redacted.replace(/([?&#]apikey=)[^&#\s"'<>]*/gi, `$1${REDACTED}`);
}

function redactCause(cause: unknown, apiKey?: string): unknown {
  if (cause instanceof Error) return redactError(cause, apiKey);
  if (typeof cause === "string") return redactUrl(cause, apiKey);
  try {
    const serialized = JSON.stringify(cause);
    if (typeof serialized !== "string") return undefined;
    return redactUrl(serialized, apiKey);
  } catch {
    return undefined;
  }
}

function copyRedacted<T extends Error>(error: Error, redacted: T, apiKey?: string): T {
  redacted.name = error.name;
  if (typeof error.stack === "string") {
    redacted.stack = redactUrl(error.stack, apiKey);
  }
  return redacted;
}

function redactAggregate(error: AggregateError, apiKey?: string): AggregateError {
  const errors: unknown[] = [];
  for (const item of error.errors) {
    const redacted = item instanceof Error ? redactError(item, apiKey) : redactCause(item, apiKey);
    if (redacted !== undefined) errors.push(redacted);
  }
  const cause = error.cause === undefined ? undefined : redactCause(error.cause, apiKey);
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

/** Copies an error with `redactUrl` applied to message, stack, and cause. */
export function redactError(error: unknown, apiKey?: string): Error {
  if (error instanceof AggregateError) return redactAggregate(error, apiKey);
  if (!(error instanceof Error)) {
    return new Error(redactUrl(String(error), apiKey));
  }
  const cause = error.cause === undefined ? undefined : redactCause(error.cause, apiKey);
  return copyRedacted(
    error,
    new Error(redactUrl(error.message, apiKey), cause === undefined ? undefined : { cause }),
    apiKey
  );
}
