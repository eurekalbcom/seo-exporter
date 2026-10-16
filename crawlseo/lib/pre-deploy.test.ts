import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");

describe("pre-deploy bind and vendored workflows", () => {
  it("publishes the app on loopback only and does not force AUTH_TRUST_HOST", () => {
    const compose = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");
    const example = readFileSync(join(ROOT, ".env.example"), "utf8");
    const auth = readFileSync(join(ROOT, "lib/auth.ts"), "utf8");
    expect(compose).toContain("127.0.0.1:3000:3000");
    expect(compose).not.toMatch(/["']3000:3000["']/);
    expect(compose).not.toContain("0.0.0.0:3000");
    expect(compose).not.toMatch(/AUTH_TRUST_HOST\s*[:=]\s*["']?true/);
    expect(compose).not.toMatch(/CRAWL_ALLOWED_DOMAINS:\s*\$\{CRAWL_ALLOWED_DOMAINS:-[^}\s]+/);
    expect(example).toMatch(/Unset or empty denies every domain/);
    expect(example).not.toMatch(/^AUTH_TRUST_HOST=true$/m);
    expect(auth).toContain('process.env.AUTH_TRUST_HOST?.trim().toLowerCase() === "true"');
  });

  it("does not vendor GitHub workflows from CrawlSEO", () => {
    const dir = join(ROOT, ".github/workflows");
    if (!existsSync(dir)) return;
    const workflows = readdirSync(dir).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));
    expect(workflows).toEqual([]);
  });
});
