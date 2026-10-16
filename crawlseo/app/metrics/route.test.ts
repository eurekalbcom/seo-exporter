import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: null as PrismaClient | null }));

vi.mock("@/lib/db", async () => {
  const { lazyDb } = await import("@/lib/testing/pglite");
  return { db: lazyDb(holder) };
});

import { createTestDb, type TestDb } from "@/lib/testing/pglite";
import { GET } from "./route";

let t: TestDb;

function gauge(body: string, name: string, domain: string, extra?: string): number {
  const line = body.split("\n").find((row) => {
    if (!row.startsWith(`${name}{`)) return false;
    if (!row.includes(`domain="${domain}"`)) return false;
    return extra ? row.includes(extra) : true;
  });
  expect(line, `${name} ${domain} ${extra ?? ""}`).toBeDefined();
  return Number(line!.trim().split(" ").at(-1));
}

beforeAll(async () => {
  t = await createTestDb();
  holder.db = t.db;
  const db = t.db;
  const recent = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const stale = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);

  await db.user.create({ data: { id: "u1", email: "metrics@example.com" } });
  await db.site.create({ data: { id: "www", userId: "u1", domain: "www.bezkolejki.org" } });
  await db.site.create({ data: { id: "apex", userId: "u1", domain: "eurekalb.com" } });

  await db.page.createMany({
    data: [
      { siteId: "www", url: "https://www.bezkolejki.org/", date: recent, clicks: 10, impressions: 100, position: 2 },
      { siteId: "www", url: "https://www.bezkolejki.org/zero", date: recent, clicks: 0, impressions: 0, position: 20 },
      { siteId: "www", url: "https://www.bezkolejki.org/old", date: stale, clicks: 1000, impressions: 1000, position: 1 },
    ],
  });
  await db.keyword.create({
    data: { siteId: "www", query: "anonymised-gap", date: recent, clicks: 99, impressions: 99, position: 1 },
  });

  await db.crawl.create({
    data: { id: "old", siteId: "www", status: "COMPLETED", finishedAt: stale },
  });
  await db.crawl.create({
    data: { id: "latest", siteId: "www", status: "COMPLETED", finishedAt: recent },
  });
  await db.crawl.create({
    data: { id: "running", siteId: "www", status: "RUNNING", startedAt: new Date() },
  });
  await db.crawlIssue.createMany({
    data: [
      { crawlId: "old", url: "https://www.bezkolejki.org/a", type: "BROKEN_LINK", severity: "CRITICAL", message: "old" },
      { crawlId: "old", url: "https://www.bezkolejki.org/b", type: "BROKEN_LINK", severity: "CRITICAL", message: "old" },
      { crawlId: "old", url: "https://www.bezkolejki.org/c", type: "BROKEN_LINK", severity: "CRITICAL", message: "old" },
      { crawlId: "latest", url: "https://www.bezkolejki.org/d", type: "MISSING_TITLE", severity: "WARNING", message: "live" },
      {
        crawlId: "latest",
        url: "https://www.bezkolejki.org/",
        type: "MISSING_TITLE",
        severity: "INFO",
        message: "summary",
        details: { kind: "crawl_summary" },
      },
      {
        crawlId: "latest",
        url: "https://www.bezkolejki.org/thin",
        type: "MISSING_TITLE",
        severity: "INFO",
        message: "score",
        details: { kind: "content_score" },
      },
      { crawlId: "running", url: "https://www.bezkolejki.org/e", type: "BROKEN_LINK", severity: "CRITICAL", message: "running" },
    ],
  });
}, 120_000);

afterAll(async () => {
  await t?.close();
});

describe("GET /metrics", () => {
  it("counts page totals and the latest visible crawl, not keywords or history", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.text();

    expect(gauge(body, "seo_clicks", "www.bezkolejki.org")).toBe(10);
    expect(gauge(body, "seo_impressions", "www.bezkolejki.org")).toBe(100);
    expect(gauge(body, "seo_position", "www.bezkolejki.org")).toBe(2);
    expect(gauge(body, "seo_clicks", "eurekalb.com")).toBe(0);
    expect(gauge(body, "seo_crawl_issues", "www.bezkolejki.org", 'severity="WARNING"')).toBe(1);
    expect(body).not.toContain('severity="CRITICAL"');
    expect(body).not.toContain('severity="INFO"');
  });
});
