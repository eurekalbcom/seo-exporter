import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Compares two secrets in constant time, including when their lengths differ.
 * `timingSafeEqual` throws on unequal buffer lengths, so both sides are hashed
 * first and the digests are compared.
 */
export function secretsEqual(left: string, right: string): boolean {
  const a = createHash("sha256").update(left, "utf8").digest();
  const b = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** Bearer token from Authorization. Missing or empty configured token fails closed. */
export function bearerMatches(authorization: string | null, expected: string | undefined): boolean {
  if (!expected) return false;
  const prefix = "Bearer ";
  if (!authorization?.startsWith(prefix)) return false;
  const presented = authorization.slice(prefix.length);
  if (!presented) return false;
  return secretsEqual(presented, expected);
}
