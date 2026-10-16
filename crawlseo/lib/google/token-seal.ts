import type { Adapter, AdapterAccount } from "@auth/core/adapters";
import { decrypt, encrypt } from "@/lib/encryption";

const PREFIX = "enc:v1:";

export type SealedJson = { enc: "v1"; data: string };

type TokenUser = {
  id: string;
  googleTokens: unknown;
};

type TokenAccount = {
  id: string;
  access_token: string | null;
  refresh_token: string | null;
};

export type TokenSealClient = {
  user: {
    findMany: (args: { select: { id: true; googleTokens: true } }) => Promise<TokenUser[]>;
    update: (args: { where: { id: string }; data: { googleTokens: SealedJson } }) => Promise<unknown>;
  };
  account: {
    findMany: (args: {
      select: { id: true; access_token: true; refresh_token: true };
    }) => Promise<TokenAccount[]>;
    update: (args: {
      where: { id: string };
      data: { access_token?: string; refresh_token?: string };
    }) => Promise<unknown>;
  };
};

export function isSealedString(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function sealString(plain: string): string {
  if (isSealedString(plain)) return plain;
  return PREFIX + encrypt(plain);
}

export function openString(stored: string): string {
  if (!isSealedString(stored)) return stored;
  return decrypt(stored.slice(PREFIX.length));
}

export function isSealedJson(value: unknown): value is SealedJson {
  if (!value || typeof value !== "object") return false;
  const record = value as { enc?: unknown; data?: unknown };
  return record.enc === "v1" && typeof record.data === "string";
}

export function sealJson(value: unknown): SealedJson {
  if (isSealedJson(value)) return value;
  return { enc: "v1", data: encrypt(JSON.stringify(value)) };
}

export function openJson<T>(value: unknown): T {
  if (isSealedJson(value)) return JSON.parse(decrypt(value.data)) as T;
  return value as T;
}

export function sealAccountTokens<T extends Pick<AdapterAccount, "access_token" | "refresh_token">>(account: T): T {
  return {
    ...account,
    access_token: account.access_token ? sealString(account.access_token) : account.access_token,
    refresh_token: account.refresh_token ? sealString(account.refresh_token) : account.refresh_token,
  };
}

/** Wraps the Auth.js adapter so Account access and refresh tokens are sealed before insert. */
export function withSealedAccounts(adapter: Adapter): Adapter {
  if (!adapter.linkAccount) return adapter;
  const linkAccount = adapter.linkAccount.bind(adapter);
  return {
    ...adapter,
    linkAccount: (account) => linkAccount(sealAccountTokens(account)),
  };
}

/**
 * Rewrites plaintext User.googleTokens and Account access/refresh tokens.
 * Already sealed rows are left untouched. Safe to run on every boot.
 */
export async function migrateGoogleTokens(client: TokenSealClient): Promise<{ users: number; accounts: number }> {
  let users = 0;
  let accounts = 0;
  const userRows = await client.user.findMany({ select: { id: true, googleTokens: true } });
  for (const row of userRows) {
    if (row.googleTokens && !isSealedJson(row.googleTokens)) {
      await client.user.update({ where: { id: row.id }, data: { googleTokens: sealJson(row.googleTokens) } });
      users += 1;
    }
  }
  const accountRows = await client.account.findMany({
    select: { id: true, access_token: true, refresh_token: true },
  });
  for (const row of accountRows) {
    const data: { access_token?: string; refresh_token?: string } = {};
    if (row.access_token && !isSealedString(row.access_token)) data.access_token = sealString(row.access_token);
    if (row.refresh_token && !isSealedString(row.refresh_token)) data.refresh_token = sealString(row.refresh_token);
    if (data.access_token || data.refresh_token) {
      await client.account.update({ where: { id: row.id }, data });
      accounts += 1;
    }
  }
  return { users, accounts };
}
