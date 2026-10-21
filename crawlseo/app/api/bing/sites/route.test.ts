import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { encrypt } from "@/lib/encryption";

const db = vi.hoisted(() => ({ apiKey: { findUnique: vi.fn() } }));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "user-1" } }) }));
vi.mock("@/lib/db", () => ({ db }));

import { listBingSites } from "@/lib/bing";
import { GET } from "./route";

describe("GET /api/bing/sites", () => {
  const saved = process.env.BING_ENABLED;

  beforeAll(() => {
    process.env.NEXTAUTH_SECRET = "test-secret-for-vitest-only";
  });

  beforeEach(() => {
    process.env.BING_ENABLED = "true";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    if (saved === undefined) delete process.env.BING_ENABLED;
    else process.env.BING_ENABLED = saved;
  });

  it("keeps 400 for a missing key and 500 for a timeout", async () => {
    db.apiKey.findUnique.mockResolvedValueOnce(null);
    const missing = await GET();
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ code: "BING_KEY_MISSING" });

    const key = "secret/key 9f3a";
    db.apiKey.findUnique.mockResolvedValue({
      encryptedLogin: null,
      encryptedPassword: encrypt(key),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException(`aborted ${key}`, "TimeoutError");
      })
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const timedOut = await GET();
      expect(timedOut.status).toBe(500);
      expect(JSON.stringify(await timedOut.json())).not.toContain(key);

      let caught: unknown;
      try {
        await listBingSites("user-1");
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DOMException);
      if (!(caught instanceof DOMException)) return;
      expect(caught.name).toBe("TimeoutError");
      expect(caught.message).not.toContain(key);
      const logged = spy.mock.calls.flat().map((part) => String(part)).join("\n");
      expect(logged).not.toContain(key);
    } finally {
      spy.mockRestore();
    }
  });
});
