import { assertCrawlDomainAllowed } from "../allowlist";
import { extractHtml } from "./html-page";
import { parseRobots, robotsAllows, robotsCrawlDelay } from "./robots";
import { safeRequest, USER_AGENT, type FetchLike } from "./safe-http";

export { USER_AGENT };
export type { FetchLike };

export const LIVE_ORIGINS = ["https://bezkolejki.org", "https://eurekalb.com"] as const;
export const MAX_CRAWL_DELAY_S = 60;

const MAX_BODY = 1_000_000;
const MAX_SITEMAPS = 5;
const MAX_SITEMAP_URLS = 200;

export type CrawlRequest = {
  url: string;
  method: "GET" | "HEAD";
  status: number;
};

export type CrawlRedirect = {
  from: string;
  to: string;
  status: number;
};

export type CrawlPage = {
  url: string;
  status: number;
  contentType: string;
  title: string | null;
  metaDescription: string | null;
  canonical: string | null;
  h1: string[];
  noindex: boolean;
  links: string[];
  parsedHtml: boolean;
};

export type BrokenLink = { from: string; to: string; status: number };
export type RobotsOutcome = "rules" | "missing" | "unreachable" | "delay-too-long";

export type OriginCrawl = {
  origin: string;
  robotsStatus: number | null;
  robotsOutcome: RobotsOutcome;
  crawlDelaySeconds: number | null;
  sitemapUrls: string[];
  pages: CrawlPage[];
  redirects: CrawlRedirect[];
  blockedByRobots: string[];
  brokenLinks: BrokenLink[];
  skippedOffHost: string[];
  requests: CrawlRequest[];
};

export type CrawlOptions = {
  origins: readonly string[];
  fetchImpl: FetchLike;
  env?: NodeJS.ProcessEnv;
  minDelayMs?: number;
  maxPages?: number;
  maxLinkChecks?: number;
  maxRedirects?: number;
  sleep?: (ms: number) => Promise<void>;
};

export function hostOf(value: string): string {
  return new URL(value).hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}

export function sameSite(origin: string, url: string): boolean {
  try {
    return hostOf(origin) === hostOf(url);
  } catch {
    return false;
  }
}

export function normalizeUrl(value: string, base?: string): string {
  const url = base ? new URL(value, base) : new URL(value);
  url.hash = "";
  if (url.pathname !== "/" && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  return url.toString();
}

async function readCapped(res: Response): Promise<string> {
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.subarray(0, MAX_BODY).toString("utf8");
}

export async function crawlOrigins(options: CrawlOptions): Promise<OriginCrawl[]> {
  const reports: OriginCrawl[] = [];
  for (const origin of options.origins) {
    reports.push(await crawlOrigin(origin, options));
  }
  return reports;
}

async function crawlOrigin(originInput: string, options: CrawlOptions): Promise<OriginCrawl> {
  const origin = new URL(originInput).origin;
  assertCrawlDomainAllowed(origin, options.env);
  const minDelayMs = options.minDelayMs ?? 1000;
  const maxPages = options.maxPages ?? 30;
  const maxLinkChecks = options.maxLinkChecks ?? 40;
  const maxRedirects = options.maxRedirects ?? 5;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const requests: CrawlRequest[] = [];
  let paced = false;
  let waitMs = minDelayMs;

  const report: OriginCrawl = {
    origin,
    robotsStatus: null,
    robotsOutcome: "missing",
    crawlDelaySeconds: null,
    sitemapUrls: [],
    pages: [],
    redirects: [],
    blockedByRobots: [],
    brokenLinks: [],
    skippedOffHost: [],
    requests,
  };

  async function pace(): Promise<void> {
    if (paced && waitMs > 0) await sleep(waitMs);
    paced = true;
  }

  async function get(url: string): Promise<Response> {
    const target = normalizeUrl(url);
    if (!sameSite(origin, target)) throw new Error(`Refusing off-site fetch ${target}`);
    assertCrawlDomainAllowed(target, options.env);
    await pace();
    const response = await safeRequest(options.fetchImpl, target, { method: "GET" });
    requests.push({ url: target, method: "GET", status: response.status });
    return response;
  }

  let robotsText = "";
  const robotsRes = await get(`${origin}/robots.txt`);
  report.robotsStatus = robotsRes.status;
  if (robotsRes.status === 429 || robotsRes.status >= 500) {
    report.robotsOutcome = "unreachable";
    await readCapped(robotsRes);
    return report;
  }
  if (robotsRes.status >= 400) {
    report.robotsOutcome = "missing";
    await readCapped(robotsRes);
  } else {
    robotsText = await readCapped(robotsRes);
    report.robotsOutcome = "rules";
  }

  const parsed = parseRobots(robotsText);
  const delay = robotsCrawlDelay(parsed, USER_AGENT);
  report.crawlDelaySeconds = delay;
  if (delay !== null && delay > MAX_CRAWL_DELAY_S) {
    report.robotsOutcome = "delay-too-long";
    return report;
  }
  if (delay !== null) waitMs = Math.max(waitMs, delay * 1000);

  const allowed = (url: string): boolean => {
    if (report.robotsOutcome !== "rules") return true;
    return robotsAllows(parsed, url, USER_AGENT);
  };

  const noteBlocked = (url: string) => {
    if (!report.blockedByRobots.includes(url)) report.blockedByRobots.push(url);
  };

  const sitemapQueue = [...parsed.sitemaps, `${origin}/sitemap.xml`];
  const seenSitemaps = new Set<string>();
  const pageLocs: string[] = [];
  while (sitemapQueue.length > 0 && seenSitemaps.size < MAX_SITEMAPS) {
    const next = sitemapQueue.shift();
    if (!next) break;
    let sitemapUrl: string;
    try {
      sitemapUrl = normalizeUrl(next);
    } catch {
      continue;
    }
    if (seenSitemaps.has(sitemapUrl) || !sameSite(origin, sitemapUrl)) continue;
    seenSitemaps.add(sitemapUrl);
    if (!allowed(sitemapUrl)) {
      noteBlocked(sitemapUrl);
      continue;
    }
    const res = await get(sitemapUrl);
    if (res.status < 200 || res.status >= 300) {
      await readCapped(res);
      continue;
    }
    const xml = await readCapped(res);
    const locs = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((match) =>
      (match[1] ?? "").replace(/&amp;/g, "&").trim()
    );
    const index = /<sitemapindex\b/i.test(xml);
    for (const loc of locs) {
      if (!loc) continue;
      if (index) {
        sitemapQueue.push(loc);
        continue;
      }
      if (pageLocs.length >= MAX_SITEMAP_URLS) continue;
      try {
        pageLocs.push(normalizeUrl(loc));
      } catch {
        continue;
      }
    }
  }
  report.sitemapUrls = pageLocs;

  type Document = {
    finalUrl: string;
    status: number;
    contentType: string;
    body: string;
    xRobots: string | null;
  };

  async function fetchDocument(start: string): Promise<Document | null> {
    let current = normalizeUrl(start);
    for (let hop = 0; hop <= maxRedirects; hop++) {
      if (!sameSite(origin, current)) return null;
      if (!allowed(current)) {
        noteBlocked(current);
        return null;
      }
      const res = await get(current);
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        let next: string;
        try {
          next = normalizeUrl(location, current);
        } catch {
          await readCapped(res);
          return null;
        }
        report.redirects.push({ from: current, to: next, status: res.status });
        await readCapped(res);
        if (!sameSite(origin, next)) return null;
        current = next;
        continue;
      }
      return {
        finalUrl: current,
        status: res.status,
        contentType: res.headers.get("content-type") ?? "",
        body: await readCapped(res),
        xRobots: res.headers.get("x-robots-tag"),
      };
    }
    return null;
  }

  const queue: string[] = [];
  const queued = new Set<string>();
  const enqueue = (value: string) => {
    let url: string;
    try {
      url = normalizeUrl(value);
    } catch {
      return;
    }
    if (queued.has(url)) return;
    queued.add(url);
    queue.push(url);
  };

  enqueue(`${origin}/`);
  for (const loc of pageLocs) enqueue(loc);

  const seenDocs = new Set<string>();
  while (queue.length > 0 && report.pages.length < maxPages) {
    const url = queue.shift();
    if (!url || seenDocs.has(url)) continue;
    if (!sameSite(origin, url)) {
      report.skippedOffHost.push(url);
      continue;
    }
    seenDocs.add(url);
    const doc = await fetchDocument(url);
    if (!doc) continue;
    seenDocs.add(doc.finalUrl);
    if (report.pages.some((page) => page.url === doc.finalUrl)) continue;
    const looksHtml = /html/i.test(doc.contentType) || /<!doctype|<html/i.test(doc.body);
    const parsedHtml = doc.status === 200 && looksHtml;
    const extract = parsedHtml
      ? extractHtml(doc.body, doc.finalUrl, doc.xRobots)
      : { title: null, metaDescription: null, canonical: null, h1: [] as string[], noindex: false, links: [] as string[] };
    report.pages.push({
      url: doc.finalUrl,
      status: doc.status,
      contentType: doc.contentType,
      title: extract.title,
      metaDescription: extract.metaDescription,
      canonical: extract.canonical,
      h1: extract.h1,
      noindex: extract.noindex,
      links: extract.links,
      parsedHtml,
    });
    for (const link of extract.links) {
      if (!sameSite(origin, link)) {
        if (!report.skippedOffHost.includes(link)) report.skippedOffHost.push(link);
        continue;
      }
      enqueue(link);
    }
  }

  let linkChecks = 0;
  for (const page of report.pages) {
    if (page.status !== 200) continue;
    for (const link of page.links) {
      if (!sameSite(origin, link)) continue;
      const normalized = normalizeUrl(link);
      if (!allowed(normalized)) continue;
      const known = report.pages.find((item) => item.url === normalized);
      let status = known?.status ?? null;
      if (status === null && linkChecks < maxLinkChecks) {
        linkChecks += 1;
        const doc = await fetchDocument(normalized);
        status = doc?.status ?? null;
        if (doc && !report.pages.some((item) => item.url === doc.finalUrl)) {
          report.pages.push({
            url: doc.finalUrl,
            status: doc.status,
            contentType: doc.contentType,
            title: null,
            metaDescription: null,
            canonical: null,
            h1: [],
            noindex: false,
            links: [],
            parsedHtml: false,
          });
        }
      }
      if (status !== null && status >= 400) {
        report.brokenLinks.push({ from: page.url, to: normalized, status });
      }
    }
  }

  return report;
}
