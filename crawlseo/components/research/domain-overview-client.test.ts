import { describe, expect, it } from "vitest";
import { sourceLabel } from "./domain-overview-client";

describe("sourceLabel", () => {
  it("shows UNAVAILABLE, not NONE, when no provider had data", () => {
    expect(sourceLabel("none")).toBe("UNAVAILABLE");
  });

  it("keeps the provider name for Search Console", () => {
    expect(sourceLabel("gsc")).toBe("GSC");
  });
});
