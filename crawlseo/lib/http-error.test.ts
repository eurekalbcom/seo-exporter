import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const APP = join(__dirname, "..", "app");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (name === "route.ts") out.push(path);
  }
  return out;
}

describe("HTTP 500 handlers", () => {
  it("logs the exception and does not put error.message in the response", () => {
    const leaks: string[] = [];
    for (const file of walk(APP)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/status:\s*500/g)) {
        const at = match.index ?? 0;
        const returnAt = text.lastIndexOf("return", at);
        const response = text.slice(returnAt, at + match[0].length);
        if (response.includes(".message")) leaks.push(file);
        const catchAt = text.lastIndexOf("catch", returnAt);
        if (!text.slice(catchAt, returnAt).includes("console.error")) {
          leaks.push(`${file} (no log)`);
        }
      }
    }
    expect(leaks).toEqual([]);
  });
});
