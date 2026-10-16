/** Replaces every `apikey` query value so a request URL can be logged. */
export function redactUrl(value: string): string {
  return value.replace(/([?&]apikey=)[^&#\s"'<>]*/gi, "$1[REDACTED]");
}

function redactCause(cause: unknown): unknown {
  if (cause instanceof Error) return redactError(cause);
  if (typeof cause === "string") return redactUrl(cause);
  return cause;
}

/** Copies an error with `redactUrl` applied to message, stack, and cause. */
export function redactError(error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(redactUrl(String(error)));
  }
  const cause = error.cause === undefined ? undefined : redactCause(error.cause);
  const redacted = new Error(
    redactUrl(error.message),
    cause === undefined ? undefined : { cause }
  );
  redacted.name = error.name;
  if (typeof error.stack === "string") {
    redacted.stack = redactUrl(error.stack);
  }
  return redacted;
}
