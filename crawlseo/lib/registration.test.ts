import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { account: { findUnique } } }));

import { isSignInAllowed } from "./registration";

const google = { provider: "google", providerAccountId: "1234567890" };
const allowed = "echo@eurekalb.com";

describe("isSignInAllowed", () => {
  const savedRegistration = process.env.DISABLE_REGISTRATION;
  const savedAllow = process.env.ALLOWED_EMAILS;

  beforeEach(() => {
    findUnique.mockReset();
    process.env.ALLOWED_EMAILS = allowed;
  });

  afterEach(() => {
    if (savedRegistration === undefined) delete process.env.DISABLE_REGISTRATION;
    else process.env.DISABLE_REGISTRATION = savedRegistration;
    if (savedAllow === undefined) delete process.env.ALLOWED_EMAILS;
    else process.env.ALLOWED_EMAILS = savedAllow;
  });

  it("refuses everyone when the allowlist is unset", async () => {
    delete process.env.ALLOWED_EMAILS;
    delete process.env.DISABLE_REGISTRATION;
    expect(await isSignInAllowed({ account: google, email: allowed })).toBe(false);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("refuses an email that is not on the allowlist", async () => {
    process.env.DISABLE_REGISTRATION = "false";
    expect(await isSignInAllowed({ account: google, email: "other@example.com" })).toBe(false);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("lets an allowlisted new account sign in only when registration is explicitly open", async () => {
    process.env.DISABLE_REGISTRATION = "false";
    expect(await isSignInAllowed({ account: google, email: "Echo@EurekaLB.com" })).toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("closes registration by default", async () => {
    delete process.env.DISABLE_REGISTRATION;
    findUnique.mockResolvedValue(null);
    expect(await isSignInAllowed({ account: google, email: allowed })).toBe(false);
    expect(findUnique).toHaveBeenCalled();
  });

  it("keeps letting an existing allowlisted account sign in when registration is closed", async () => {
    process.env.DISABLE_REGISTRATION = " TRUE ";
    findUnique.mockResolvedValue({ id: "acc-1" });
    expect(await isSignInAllowed({ account: google, email: allowed })).toBe(true);
  });

  it("refuses a sign-in without an OAuth account when registration is closed", async () => {
    process.env.DISABLE_REGISTRATION = "true";
    expect(await isSignInAllowed({ account: null, email: allowed })).toBe(false);
    expect(findUnique).not.toHaveBeenCalled();
  });
});
