import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { JOB_HOST_ALLOWLIST, JobTargetDeniedError, jobUrl, triggerJob, type TriggerJob } from "../src/client";

const TOKEN = "eur421-test-token";

function restoreAllowlist(previous: string | undefined): void {
  if (previous === undefined) delete process.env.CRAWL_ALLOWED_DOMAINS;
  else process.env.CRAWL_ALLOWED_DOMAINS = previous;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (address && typeof address !== "string") resolve(address.port);
      else reject(new Error("expected a tcp port"));
    });
  });
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

async function expectDeniedBeforeRequest(baseUrl: string, job: TriggerJob = "crawl"): Promise<void> {
  let called = false;
  const previous = process.env.CRAWL_ALLOWED_DOMAINS;
  process.env.CRAWL_ALLOWED_DOMAINS = "eurekalb.com";
  let thrown: unknown;
  try {
    await triggerJob({
      baseUrl,
      token: TOKEN,
      job,
      domain: "eurekalb.com",
      fetchImpl: (async () => {
        called = true;
        return new Response("no", { status: 200 });
      }) as typeof fetch,
    });
  } catch (error) {
    thrown = error;
  } finally {
    restoreAllowlist(previous);
  }
  expect(called).toBe(false);
  expect(thrown).toBeInstanceOf(JobTargetDeniedError);
  expect(thrown instanceof Error ? thrown.message : "").not.toContain(TOKEN);
}

describe("job host allowlist", () => {
  afterEach(() => {
    delete process.env.CRAWL_ALLOWED_DOMAINS;
  });

  it("is localhost, 127.0.0.1, and the compose service name", () => {
    expect([...JOB_HOST_ALLOWLIST]).toEqual(["localhost", "127.0.0.1", "app"]);
  });

  it.each([
    ["http://127.0.0.1:3000", "http://127.0.0.1:3000/api/internal/jobs"],
    ["http://localhost:3000", "http://localhost:3000/api/internal/jobs"],
    ["https://localhost", "https://localhost/api/internal/jobs"],
    ["http://app:3000", "http://app:3000/api/internal/jobs"],
    ["https://app", "https://app/api/internal/jobs"],
    ["HTTP://APP:3000", "http://app:3000/api/internal/jobs"],
    ["http://127.1:3000", "http://127.0.0.1:3000/api/internal/jobs"],
  ])("posts %s with redirect manual", async (baseUrl, expected) => {
    const calls: Array<{ url: string; redirect?: RequestRedirect; authorization: string | null }> = [];
    const previous = process.env.CRAWL_ALLOWED_DOMAINS;
    process.env.CRAWL_ALLOWED_DOMAINS = "eurekalb.com";
    try {
      await triggerJob({
        baseUrl,
        token: TOKEN,
        job: "gsc-sync",
        domain: "eurekalb.com",
        fetchImpl: (async (input, init) => {
          calls.push({
            url: String(input),
            redirect: init?.redirect,
            authorization: new Headers(init?.headers).get("authorization"),
          });
          return new Response("ok", { status: 202 });
        }) as typeof fetch,
      });
    } finally {
      restoreAllowlist(previous);
    }
    expect(calls).toEqual([
      {
        url: expected,
        redirect: "manual",
        authorization: `Bearer ${TOKEN}`,
      },
    ]);
  });

  it("strips a query and hash so the token cannot ride on the jobs URL", () => {
    const url = jobUrl(`http://127.0.0.1:3000/?access_token=${TOKEN}#frag`);
    expect(url.toString()).toBe("http://127.0.0.1:3000/api/internal/jobs");
  });

  it.each([
    ["foreign host", "http://example.com"],
    ["foreign host with jobs path", "http://example.com:3000/api/internal/jobs"],
    ["foreign https host", "https://example.com"],
    ["localhost suffix", "http://localhost.example.com"],
    ["compose name suffix", "http://app.example.com"],
    ["loopback suffix", "http://127.0.0.1.example.com"],
    ["other loopback", "http://127.0.0.2"],
    ["unspecified address", "http://0.0.0.0"],
    ["ipv6 loopback", "http://[::1]"],
    ["trailing dot", "http://app."],
    ["userinfo hiding a foreign host", "http://127.0.0.1@example.com"],
    ["token in userinfo", `http://${TOKEN}@example.com`],
    ["foreign userinfo on loopback", "http://example.com@127.0.0.1"],
    ["token password on loopback", `http://user:${TOKEN}@127.0.0.1:3000`],
    ["token in query on a foreign host", `http://example.com/?access_token=${TOKEN}`],
  ])("rejects %s before any request", async (_label, baseUrl) => {
    await expectDeniedBeforeRequest(baseUrl);
  });

  it.each([
    ["ftp", "ftp://127.0.0.1/api/internal/jobs"],
    ["file", "file:///etc/passwd"],
    ["ws", "ws://localhost:3000"],
    ["javascript", "javascript:alert(1)"],
  ])("rejects non-http scheme %s before any request", async (_label, baseUrl) => {
    await expectDeniedBeforeRequest(baseUrl, "vitals");
  });

  it.each([
    ["empty", ""],
    ["missing host", "http://"],
    ["not a url", "not a url"],
  ])("rejects invalid baseUrl (%s) before any request", async (_label, baseUrl) => {
    await expectDeniedBeforeRequest(baseUrl);
  });

  it.each([301, 302, 303, 307, 308])(
    "rejects HTTP %s and does not send the token to the redirect target",
    async (status) => {
      const targetHits: string[] = [];
      const sourceHits: string[] = [];
      const target = createServer((req, res) => {
        req.resume();
        targetHits.push(req.headers.authorization ?? "");
        res.writeHead(200);
        res.end("no");
      });
      let source: Server | undefined;
      const previous = process.env.CRAWL_ALLOWED_DOMAINS;
      process.env.CRAWL_ALLOWED_DOMAINS = "eurekalb.com";
      try {
        const targetPort = await listen(target);
        source = createServer((req, res) => {
          req.resume();
          sourceHits.push(req.headers.authorization ?? "");
          res.writeHead(status, { location: `http://127.0.0.1:${targetPort}/steal` });
          res.end();
        });
        const sourcePort = await listen(source);
        let thrown: unknown;
        try {
          await triggerJob({
            baseUrl: `http://127.0.0.1:${sourcePort}`,
            token: TOKEN,
            job: "crawl",
            domain: "eurekalb.com",
          });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(JobTargetDeniedError);
        expect(thrown instanceof Error ? thrown.message : "").toBe("Refusing job redirect");
        expect(String(thrown)).not.toContain(TOKEN);
        expect(sourceHits).toEqual([`Bearer ${TOKEN}`]);
        expect(targetHits).toEqual([]);
      } finally {
        restoreAllowlist(previous);
        if (source) await closeServer(source);
        await closeServer(target);
      }
    }
  );
});
