import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testBingKey = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "user-1" } }) }));
vi.mock("@/lib/bing", () => ({ testBingKey }));

import { POST } from "./route";

describe("POST /api/user/api-keys/test", () => {
  const saved = process.env.BING_ENABLED;

  beforeEach(() => {
    process.env.BING_ENABLED = "true";
  });

  afterEach(() => {
    vi.clearAllMocks();
    if (saved === undefined) delete process.env.BING_ENABLED;
    else process.env.BING_ENABLED = saved;
  });

  it("redacts the submitted key from the error log", async () => {
    const key = "secret/key 9f3a";
    testBingKey.mockRejectedValue(new Error(`failed ${key} ${key.toUpperCase()}`));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await POST(
        new Request("http://localhost/api/user/api-keys/test", {
          method: "POST",
          body: JSON.stringify({ provider: "bing", apiKey: key }),
        })
      );
      expect(res.status).toBe(500);
      const body = JSON.stringify(await res.json());
      expect(body).toBe('{"error":"Connection test failed"}');
      expect(body).not.toContain(key);
      const logged = spy.mock.calls
        .flat()
        .map((part) => (part instanceof Error ? `${part.message}\n${part.stack ?? ""}` : String(part)))
        .join("\n");
      expect(logged).not.toContain(key);
      expect(logged.toUpperCase()).not.toContain(key.toUpperCase());
      expect(logged).toContain("[REDACTED]");
    } finally {
      spy.mockRestore();
    }
  });
});
