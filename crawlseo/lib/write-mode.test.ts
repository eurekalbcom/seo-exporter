import { afterEach, describe, expect, it } from "vitest";
import { request, type Dispatcher } from "undici";
import {
  assertExternalWriteAllowed,
  installFetchGuard,
  isBlockedExternalWrite,
  isGoogleRead,
  uninstallFetchGuard,
  writeGuardInterceptor,
  WriteDisabledError,
  writeMode,
} from "./write-mode";

const SUBMIT = "https://ssl.bing.com/webmaster/api.svc/json/SubmitUrl";
const QUERY = "https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aeurekalb.com/searchAnalytics/query";
const ADD_SITE = "https://www.googleapis.com/webmasters/v3/sites";
const TOKEN = "https://oauth2.googleapis.com/token";
const INSPECT = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";

afterEach(() => {
  uninstallFetchGuard();
  delete process.env.WRITE_MODE;
});

describe("Google read allowlist", () => {
  it("allows known Google read endpoints and blocks POST to an unknown host", () => {
    expect(writeMode()).toBe("off");
    expect(isGoogleRead("POST", QUERY)).toBe(true);
    expect(isGoogleRead("POST", TOKEN)).toBe(true);
    expect(isGoogleRead("POST", INSPECT)).toBe(true);
    expect(isGoogleRead("GET", "https://www.googleapis.com/webmasters/v3/sites")).toBe(true);
    expect(isGoogleRead("GET", "https://www.googleapis.com/pagespeedonline/v5/runPagespeed")).toBe(true);
    expect(isGoogleRead("POST", ADD_SITE)).toBe(false);
    expect(isGoogleRead("PUT", "https://www.googleapis.com/webmasters/v3/sites/x")).toBe(false);
    expect(isGoogleRead("POST", SUBMIT)).toBe(false);

    expect(isBlockedExternalWrite("POST", SUBMIT)).toBe(true);
    expect(isBlockedExternalWrite("POST", ADD_SITE)).toBe(true);
    expect(isBlockedExternalWrite("PUT", "https://www.googleapis.com/webmasters/v3/sites/x")).toBe(true);
    expect(isBlockedExternalWrite("POST", QUERY)).toBe(false);
    expect(isBlockedExternalWrite("GET", "https://ssl.bing.com/webmaster/api.svc/json/GetUserSites")).toBe(false);
    expect(isBlockedExternalWrite("POST", "http://127.0.0.1:3000/api/internal/jobs")).toBe(false);

    expect(() => assertExternalWriteAllowed("POST", SUBMIT)).toThrow(WriteDisabledError);
    expect(() => assertExternalWriteAllowed("POST", QUERY)).not.toThrow();
  });

  it("blocks Bing SubmitUrl at the undici dispatcher for fetch and undici.request", async () => {
    installFetchGuard();
    const fromFetch = await fetch(SUBMIT, { method: "POST" }).then(
      () => null,
      (caught: unknown) => caught
    );
    const fetchCause = fromFetch instanceof Error && fromFetch.cause instanceof Error ? fromFetch.cause : fromFetch;
    expect(fetchCause).toBeInstanceOf(WriteDisabledError);
    await expect(request(SUBMIT, { method: "POST" })).rejects.toBeInstanceOf(WriteDisabledError);
  });

  it("lets an allowlisted POST through the interceptor and blocks an unknown POST before dispatch", () => {
    const calls: string[] = [];
    const dispatch = writeGuardInterceptor()((opts, handler) => {
      calls.push(`${opts.method} ${opts.path}`);
      handler.onComplete?.(null);
      return true;
    });
    const refused: Error[] = [];
    const handler: Dispatcher.DispatchHandler = {
      onError(err: Error) {
        refused.push(err);
      },
    };

    dispatch({ origin: "https://ssl.bing.com", path: "/webmaster/api.svc/json/SubmitUrl", method: "POST" }, handler);
    dispatch({ path: "/SubmitUrl", method: "POST" }, handler);
    dispatch(
      {
        origin: "https://www.googleapis.com",
        path: "/webmasters/v3/sites/sc-domain%3Aeurekalb.com/searchAnalytics/query",
        method: "POST",
      },
      handler
    );

    expect(refused.map((err) => err.name)).toEqual(["WriteDisabledError", "WriteDisabledError"]);
    expect(calls).toEqual(["POST /webmasters/v3/sites/sc-domain%3Aeurekalb.com/searchAnalytics/query"]);
  });

  it("lifts the guard only when WRITE_MODE is exactly on, without adding a write call", () => {
    expect(isBlockedExternalWrite("POST", SUBMIT)).toBe(true);
    process.env.WRITE_MODE = "on";
    expect(writeMode()).toBe("on");
    expect(isBlockedExternalWrite("POST", SUBMIT)).toBe(false);
    process.env.WRITE_MODE = "yes";
    expect(isBlockedExternalWrite("POST", SUBMIT)).toBe(true);
  });
});
