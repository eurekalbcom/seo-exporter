import { beforeEach, describe, expect, it, vi } from "vitest";

const { findUnique, update } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(async () => ({})),
}));

vi.mock("@/lib/db", () => ({
  db: { user: { findUnique, update } },
}));

import { getAccessToken, ReauthRequiredError } from "./google-auth";

const SECRET = "refresh-response-body-must-not-leak-9f3a";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GOOGLE_CLIENT_ID = "client";
  process.env.GOOGLE_CLIENT_SECRET = "secret";
  findUnique.mockResolvedValue({
    googleTokens: { accessToken: "old", refreshToken: "refresh-token", expiresAt: 0 },
  });
});

describe("Google token refresh", () => {
  it("does not put the token endpoint response body on the error", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ error: "server_error", error_description: SECRET, access_token: SECRET }), {
          status: 400,
          statusText: "Bad Request",
        })
    );

    await expect(getAccessToken("user-1")).rejects.toThrow("Failed to refresh token: 400 Bad Request");
    await expect(getAccessToken("user-1")).rejects.not.toThrow(new RegExp(SECRET));
    expect(update).not.toHaveBeenCalled();
  });

  it("recognizes invalid_grant without echoing the response body", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ error: "invalid_grant", error_description: SECRET }), {
          status: 400,
          statusText: "Bad Request",
        })
    );

    const error = await getAccessToken("user-1").then(
      () => null,
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(ReauthRequiredError);
    expect(String(error)).not.toContain(SECRET);
  });
});
