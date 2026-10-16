import { db } from "./db";

export type SignInAccount = {
  provider: string;
  providerAccountId: string;
} | null | undefined;

/**
 * Registration is closed unless DISABLE_REGISTRATION is exactly "false".
 * ALLOWED_EMAILS is a comma-separated allowlist. An unset or empty list
 * refuses every sign-in (fail closed).
 */
export function registrationDisabled(): boolean {
  return process.env.DISABLE_REGISTRATION?.trim().toLowerCase() !== "false";
}

export function emailAllowlist(): Set<string> {
  const raw = process.env.ALLOWED_EMAILS ?? "";
  return new Set(
    raw
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  );
}

export async function isSignInAllowed(input: {
  account: SignInAccount;
  email: string | null | undefined;
}): Promise<boolean> {
  const email = input.email?.trim().toLowerCase() ?? "";
  if (!emailAllowlist().has(email)) return false;
  if (!registrationDisabled()) return true;
  if (!input.account) return false;

  const known = await db.account.findUnique({
    where: {
      provider_providerAccountId: {
        provider: input.account.provider,
        providerAccountId: input.account.providerAccountId,
      },
    },
    select: { id: true },
  });
  return known !== null;
}
