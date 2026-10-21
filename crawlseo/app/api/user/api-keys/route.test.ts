import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The provider allow-list is a plain object: without hasOwn, "constructor" and
// "__proto__" pass as providers. Removing the Bing key also disconnects every
// property that key served.

const db = vi.hoisted(() => ({
  apiKey: {
    upsert: vi.fn(async () => ({ provider: "x", updatedAt: new Date() })),
    delete: vi.fn(() => "delete-key"),
  },
  site: { updateMany: vi.fn(() => "clear-properties") },
  bingSearchWeekly: { deleteMany: vi.fn(() => "delete-weekly") },
  bingDaily: { deleteMany: vi.fn(() => "delete-daily") },
  $transaction: vi.fn(async (ops: unknown[]) => ops),
}));

vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "user-1" } }) }));
vi.mock("@/lib/db", () => ({ db }));
vi.mock("@/lib/encryption", () => ({ encrypt: (v: string) => `enc:${v}` }));

import { DELETE, POST } from "./route";

const json = (method: string, body: object) =>
  new Request("http://localhost/api/user/api-keys", {
    method,
    body: JSON.stringify(body),
  });

describe("api-keys provider allow-list", () => {
  const saved = process.env.BING_ENABLED;

  beforeEach(() => {
    process.env.BING_ENABLED = "true";
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.BING_ENABLED;
    else process.env.BING_ENABLED = saved;
  });

  it("rejects Object.prototype names as providers", async () => {
    for (const provider of ["constructor", "__proto__", "toString"]) {
      expect((await POST(json("POST", { provider, login: "x" }))).status).toBe(400);
      expect((await DELETE(json("DELETE", { provider }))).status).toBe(400);
    }
    expect(db.apiKey.upsert).not.toHaveBeenCalled();
    expect(db.apiKey.delete).not.toHaveBeenCalled();
  });

  it("answers 404 for DataForSEO and for Bing while BING_ENABLED is off", async () => {
    delete process.env.BING_ENABLED;
    expect((await POST(json("POST", { provider: "dataforseo", login: "a", password: "b" }))).status).toBe(404);
    expect((await POST(json("POST", { provider: "bing", apiKey: "k" }))).status).toBe(404);
    expect(db.apiKey.upsert).not.toHaveBeenCalled();
  });

  it("removing the Bing key disconnects its properties in one transaction", async () => {
    const res = await DELETE(json("DELETE", { provider: "bing" }));
    expect(res.status).toBe(200);
    expect(db.$transaction).toHaveBeenCalledWith([
      "clear-properties",
      "delete-weekly",
      "delete-daily",
      "delete-key",
    ]);
  });

  it("redacts a Bing key from a POST failure log", async () => {
    const key = "secret/key 9f3a";
    db.apiKey.upsert.mockRejectedValueOnce(new Error(`db ${key} ${key.toUpperCase()}`));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await POST(json("POST", { provider: "bing", apiKey: key }));
      expect(res.status).toBe(500);
      expect(JSON.stringify(await res.json())).not.toContain(key);
      const logged = spy.mock.calls
        .flat()
        .map((part) => (part instanceof Error ? `${part.message}\n${part.stack ?? ""}` : String(part)))
        .join("\n");
      expect(logged).not.toContain(key);
      expect(logged.toUpperCase()).not.toContain(key.toUpperCase());
    } finally {
      spy.mockRestore();
    }
  });
});
