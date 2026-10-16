import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Adapter, AdapterAccount } from "@auth/core/adapters";
import {
  migrateGoogleTokens,
  openJson,
  openString,
  sealAccountTokens,
  sealJson,
  sealString,
  withSealedAccounts,
  type SealedJson,
} from "./token-seal";

const ACCESS = "ya29.super-secret-access-token";
const REFRESH = "1//super-secret-refresh-token";

beforeEach(() => {
  process.env.NEXTAUTH_SECRET = "token-seal-test-secret";
});

describe("Google token sealing", () => {
  it("seals account tokens and user json so the plaintext is not stored", () => {
    const account = sealAccountTokens({
      access_token: ACCESS,
      refresh_token: REFRESH,
    } as AdapterAccount);
    expect(account.access_token?.startsWith("enc:v1:")).toBe(true);
    expect(account.refresh_token?.startsWith("enc:v1:")).toBe(true);
    expect(account.access_token).not.toContain(ACCESS);
    expect(openString(account.access_token ?? "")).toBe(ACCESS);
    expect(openString(account.refresh_token ?? "")).toBe(REFRESH);

    const sealed = sealJson({ accessToken: ACCESS, refreshToken: REFRESH });
    expect(JSON.stringify(sealed)).not.toContain(ACCESS);
    expect(JSON.stringify(sealed)).not.toContain(REFRESH);
    expect(openJson<{ accessToken: string }>(sealed).accessToken).toBe(ACCESS);
  });

  it("seals tokens inside the Auth.js linkAccount adapter", async () => {
    const seen: AdapterAccount[] = [];
    const base: Adapter = {
      linkAccount: async (account) => {
        seen.push(account);
      },
    };
    const adapter = withSealedAccounts(base);
    await adapter.linkAccount?.({
      userId: "user-1",
      type: "oauth",
      provider: "google",
      providerAccountId: "sub",
      access_token: ACCESS,
      refresh_token: REFRESH,
    });
    expect(seen[0]?.access_token).not.toContain(ACCESS);
    expect(openString(seen[0]?.access_token ?? "")).toBe(ACCESS);
  });

  it("rewrites plaintext rows and leaves sealed rows in place", async () => {
    const users = [
      { id: "plain", googleTokens: { accessToken: ACCESS, refreshToken: REFRESH } },
      { id: "sealed", googleTokens: sealJson({ accessToken: "already" }) },
      { id: "empty", googleTokens: null },
    ];
    const accounts = [
      { id: "a1", access_token: ACCESS, refresh_token: REFRESH },
      { id: "a2", access_token: sealString("kept"), refresh_token: null },
    ];
    let sealedUser: SealedJson | undefined;
    let sealedAccount: { access_token?: string; refresh_token?: string } | undefined;
    const userUpdate = vi.fn(async (args: { data: { googleTokens: SealedJson } }) => {
      sealedUser = args.data.googleTokens;
      return {};
    });
    const accountUpdate = vi.fn(
      async (args: { data: { access_token?: string; refresh_token?: string } }) => {
        sealedAccount = args.data;
        return {};
      }
    );
    const result = await migrateGoogleTokens({
      user: {
        findMany: async () => users,
        update: userUpdate,
      },
      account: {
        findMany: async () => accounts,
        update: accountUpdate,
      },
    });

    expect(result).toEqual({ users: 1, accounts: 1 });
    expect(userUpdate).toHaveBeenCalledTimes(1);
    if (!sealedUser) throw new Error("expected the plaintext user row to be sealed");
    expect(sealedUser.data).not.toContain(ACCESS);
    expect(openJson<{ accessToken: string }>(sealedUser).accessToken).toBe(ACCESS);
    expect(sealedAccount?.access_token).not.toContain(ACCESS);
    expect(openString(sealedAccount?.refresh_token ?? "")).toBe(REFRESH);
  });
});
