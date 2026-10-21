import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("dns/promises", () => ({ lookup, default: { lookup } }));
vi.mock("@/lib/db", () => ({ db: {} }));

import { isCrawlDomainAllowed } from "@/lib/crawl-allowlist";
import { fetchText } from "./engine";

const PUBLIC = "93.184.216.34";

const LITERAL_ALLOW = [
  "quilltab.app",
  "eurekalb.com",
  "93.184.216.34",
  "127.0.0.1",
  "127.0.0.2",
  "10.1.2.3",
  "172.16.0.1",
  "192.168.1.1",
  "169.254.169.254",
  "[::1]",
  "[::ffff:7f00:1]",
  "[fc00::1]",
  "[fe80::1]",
].join(",");

function publicAnswer() {
  return [{ address: PUBLIC, family: 4 }];
}

function redirect(location: string, status = 302) {
  return new Response(null, { status, headers: { location } });
}

function opaque(body: string, location?: string) {
  const res = new Response(body, {
    status: 200,
    headers: location ? { location } : undefined,
  });
  Object.defineProperty(res, "type", { value: "opaqueredirect" });
  return res;
}

describe("crawl egress fails closed", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    process.env.CRAWL_ALLOWED_DOMAINS = LITERAL_ALLOW;
    lookup.mockImplementation(async () => publicAnswer());
    fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CRAWL_ALLOWED_DOMAINS;
  });

  it.each([
    ["decimal IPv4 2130706433", "http://2130706433/latest/meta-data/"],
    ["hex short 0x7f.1", "http://0x7f.1/"],
    ["hex 0x7f000001", "http://0x7f000001/"],
    ["octal 0177.0.0.1", "http://0177.0.0.1/"],
    ["dotted 127/8", "http://127.0.0.2/"],
    ["dotted 10/8", "http://10.1.2.3/"],
    ["dotted 172.16/12", "http://172.16.0.1/"],
    ["dotted 192.168/16", "http://192.168.1.1/"],
    ["dotted metadata 169.254.169.254", "http://169.254.169.254/latest/meta-data/"],
    ["octal metadata 0251.0376.0251.0376", "http://0251.0376.0251.0376/"],
    ["hex metadata 0xA9.0xFE.0xA9.0xFE", "http://0xA9.0xFE.0xA9.0xFE/"],
    ["IPv6 loopback [::1]", "http://[::1]/"],
    ["IPv4-mapped loopback ::ffff:127.0.0.1", "http://[::ffff:127.0.0.1]/"],
    ["IPv6 unique local fc00::1", "http://[fc00::1]/"],
    ["IPv6 link-local fe80::1", "http://[fe80::1]/"],
  ])("does not fetch %s when DNS answers with a public address", async (_label, url) => {
    expect(isCrawlDomainAllowed(url)).toBe(true);

    expect(await fetchText(url)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still fetches a public IP literal that is on the allowlist", async () => {
    expect(isCrawlDomainAllowed("http://93.184.216.34/robots.txt")).toBe(true);

    expect(await fetchText("http://93.184.216.34/robots.txt")).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not follow a redirect to decimal loopback 2130706433", async () => {
    fetchMock.mockResolvedValueOnce(redirect("http://2130706433/"));

    expect(await fetchText("https://quilltab.app/start")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://quilltab.app/start");
  });

  it("does not follow a redirect to a disallowed host", async () => {
    fetchMock.mockResolvedValueOnce(redirect("https://evil.example/phish"));

    expect(await fetchText("https://quilltab.app/start")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not follow a redirect to a non-http scheme", async () => {
    fetchMock.mockResolvedValueOnce(redirect("file:///etc/passwd"));

    expect(await fetchText("https://quilltab.app/start")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not fetch a userinfo URL whose host is not the allowlisted name", async () => {
    const url = "https://quilltab.app@evil.com/robots.txt";
    expect(isCrawlDomainAllowed(url)).toBe(false);

    expect(await fetchText(url)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fetch a userinfo URL aimed at an allowlisted host", async () => {
    const url = "https://user:pass@quilltab.app/robots.txt";
    expect(isCrawlDomainAllowed(url)).toBe(true);

    expect(await fetchText(url)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not return a body from an opaqueredirect with no Location", async () => {
    fetchMock.mockResolvedValueOnce(opaque("secret"));

    expect(await fetchText("https://quilltab.app/start")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not follow an opaqueredirect whose Location is a disallowed host", async () => {
    fetchMock.mockResolvedValueOnce(opaque("secret", "https://evil.example/phish"));

    expect(await fetchText("https://quilltab.app/start")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows an opaqueredirect only after its Location is allowlisted", async () => {
    fetchMock
      .mockResolvedValueOnce(opaque("secret", "https://www.quilltab.app/next"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    expect(await fetchText("https://quilltab.app/start")).toBe("ok");
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://quilltab.app/start",
      "https://www.quilltab.app/next",
    ]);
  });

  it.each(["file:///etc/passwd", "gopher://evil.com/1", "javascript:alert(1)", "data:text/html,hi"])(
    "does not fetch non-http scheme %s",
    async (url) => {
      expect(await fetchText(url)).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it("sends only GET and does not let the client follow redirects", async () => {
    expect(await fetchText("https://quilltab.app/robots.txt")).toBe("ok");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "GET", redirect: "manual" });
  });

  it("does not fetch a trailing-dot host outside the allowlist", async () => {
    expect(await fetchText("https://evil.com./robots.txt")).toBeNull();
    expect(await fetchText("https://quilltab.app.evil.com./robots.txt")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches a trailing-dot allowlisted host", async () => {
    expect(isCrawlDomainAllowed("https://quilltab.app./robots.txt")).toBe(true);

    expect(await fetchText("https://quilltab.app./robots.txt")).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not fetch an uppercase host outside the allowlist", async () => {
    expect(await fetchText("https://EVIL.COM/robots.txt")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches an uppercase allowlisted host", async () => {
    expect(isCrawlDomainAllowed("https://QUILLTAB.APP/robots.txt")).toBe(true);

    expect(await fetchText("https://QUILLTAB.APP/robots.txt")).toBe("ok");
  });

  it("does not fetch a punycode lookalike of an allowlisted host", async () => {
    const lookalike = "https://еurekalb.com/robots.txt";
    expect(isCrawlDomainAllowed(lookalike)).toBe(false);

    expect(await fetchText(lookalike)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["127/8", "127.0.0.2"],
    ["10/8", "10.1.2.3"],
    ["172.16/12", "172.16.0.1"],
    ["192.168/16", "192.168.1.1"],
    ["169.254/16", "169.254.169.254"],
    ["::1", "::1"],
    ["fc00::/7", "fc00::1"],
    ["fe80::/10", "fe80::1"],
    ["IPv4-mapped loopback", "::ffff:127.0.0.1"],
  ])("does not fetch an allowlisted name that resolves to %s", async (_label, address) => {
    lookup.mockResolvedValue([{ address, family: address.includes(":") ? 6 : 4 }]);

    expect(isCrawlDomainAllowed("https://edge.quilltab.app/robots.txt")).toBe(true);
    expect(await fetchText("https://edge.quilltab.app/robots.txt")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("denies every host when CRAWL_ALLOWED_DOMAINS is unset", async () => {
    delete process.env.CRAWL_ALLOWED_DOMAINS;

    expect(await fetchText("https://quilltab.app/robots.txt")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("denies every host when CRAWL_ALLOWED_DOMAINS is empty", async () => {
    process.env.CRAWL_ALLOWED_DOMAINS = "   ";

    expect(await fetchText("https://quilltab.app/robots.txt")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
