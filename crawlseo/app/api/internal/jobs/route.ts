import { db } from "@/lib/db";
import { assertCrawlDomainAllowed, CrawlDomainDeniedError } from "@/lib/crawl-allowlist";
import { startSiteCrawl } from "@/lib/crawler/lifecycle";
import { comparableDomain } from "@/lib/site-domain";
import { syncGSCDataForSite } from "@/lib/workers/gsc-sync";
import { syncVitalsForSite } from "@/lib/workers/vitals-sync";

const JOBS = ["gsc-sync", "crawl", "vitals"] as const;
type JobName = (typeof JOBS)[number];

function isJob(value: unknown): value is JobName {
  return typeof value === "string" && (JOBS as readonly string[]).includes(value);
}

function authorized(req: Request): boolean {
  const token = process.env.ORCHESTRATOR_TOKEN;
  if (!token) return false;
  return req.headers.get("authorization") === `Bearer ${token}`;
}

/**
 * Adapter entry used by the orchestrator. It is not a public API: a missing
 * or wrong token is a 404. It never applies a recommendation.
 */
export async function POST(req: Request) {
  if (!authorized(req)) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  let body: { job?: unknown; domain?: unknown; maxPages?: unknown };
  try {
    body = (await req.json()) as { job?: unknown; domain?: unknown; maxPages?: unknown };
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (typeof body.domain !== "string" || !isJob(body.job)) {
    return Response.json({ error: "Missing job or domain" }, { status: 400 });
  }

  try {
    assertCrawlDomainAllowed(body.domain);
  } catch (error) {
    if (error instanceof CrawlDomainDeniedError) {
      return Response.json({ error: error.message }, { status: 403 });
    }
    throw error;
  }

  // Site.domain keeps a leading www for a URL-prefix property. The scheduler
  // sends the comparable host. Two accounts for that host are not interchangeable.
  const host = comparableDomain(body.domain);
  const sites = host
    ? await db.site.findMany({
        where: { domain: { in: [host, `www.${host}`] } },
        select: { id: true, userId: true, domain: true },
      })
    : [];
  if (sites.length > 1) {
    return Response.json({ error: "Multiple sites match this domain" }, { status: 409 });
  }
  const site = sites[0];
  if (!site) {
    return Response.json({ error: "Site not found" }, { status: 404 });
  }

  const job: JobName = body.job;
  switch (job) {
    case "gsc-sync":
      return Response.json(await syncGSCDataForSite(site.userId, site.id));
    case "crawl": {
      const maxPages = typeof body.maxPages === "number" && body.maxPages > 0 ? body.maxPages : undefined;
      const result = await startSiteCrawl(db, { id: site.id, domain: site.domain }, maxPages);
      return Response.json(result, { status: result.started ? 202 : 409 });
    }
    case "vitals":
      return Response.json(await syncVitalsForSite(site.userId, site.id));
    default: {
      const _never: never = job;
      return _never;
    }
  }
}
