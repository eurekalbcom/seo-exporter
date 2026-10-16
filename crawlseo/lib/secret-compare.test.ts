import { describe, expect, it } from "vitest";
import { bearerMatches, secretsEqual } from "./secret-compare";

describe("secretsEqual", () => {
  it("matches equal secrets and rejects different lengths without throwing", () => {
    expect(secretsEqual("orchestrator-token", "orchestrator-token")).toBe(true);
    expect(secretsEqual("short", "short-but-longer")).toBe(false);
    expect(secretsEqual("aaaaaaaa", "aaaaaaab")).toBe(false);
    expect(secretsEqual("", "x")).toBe(false);
  });
});

describe("bearerMatches", () => {
  it("requires the Bearer prefix and fails closed when the expected token is unset", () => {
    expect(bearerMatches("Bearer secret", "secret")).toBe(true);
    expect(bearerMatches("Bearer secret", "secre")).toBe(false);
    expect(bearerMatches("secret", "secret")).toBe(false);
    expect(bearerMatches("Bearer secret", undefined)).toBe(false);
    expect(bearerMatches("Bearer secret", "")).toBe(false);
    expect(bearerMatches(null, "secret")).toBe(false);
  });
});
