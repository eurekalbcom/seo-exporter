import { auth } from "@/lib/auth";
import { assertCrawlDomainAllowed, CrawlDomainDeniedError } from "@/lib/crawl-allowlist";
import { db } from "@/lib/db";
import { startSiteCrawl } from "@/lib/crawler/lifecycle";
import { visibleIssueFilter } from "@/lib/crawler/issue-filter";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ siteId: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { siteId } = await params;
    const site = await db.site.findUnique({
      where: { id: siteId },
      select: { userId: true, domain: true },
    });

    if (!site || site.userId !== session.user.id) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    try {
      assertCrawlDomainAllowed(site.domain);
    } catch (error) {
      if (error instanceof CrawlDomainDeniedError) {
        return Response.json({ error: error.message }, { status: 403 });
      }
      throw error;
    }

    // Accept optional maxPages from request body
    let maxPages: number | undefined;
    try {
      const body = (await req.json()) as { maxPages?: number };
      if (body.maxPages && typeof body.maxPages === "number" && body.maxPages > 0) {
        maxPages = body.maxPages;
      }
    } catch {
      // No body or invalid JSON: use defaults
    }

    // One crawl per site at a time. A crawl whose process died does not count:
    // startSiteCrawl marks it FAILED first (#57).
    const result = await startSiteCrawl(db, { id: siteId, domain: site.domain }, maxPages);
    if (!result.started) {
      return Response.json(
        { error: "A crawl is already running", crawlId: result.runningCrawlId },
        { status: 409 }
      );
    }

    return Response.json(
      { crawlId: result.crawlId, status: "RUNNING" },
      { status: 202 }
    );
  } catch (error) {
    console.error("Crawl error:", error);
    return Response.json(
      { error: "Crawl failed" },
      { status: 500 }
    );
  }
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ siteId: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { siteId } = await params;
    const site = await db.site.findUnique({
      where: { id: siteId },
      select: { userId: true },
    });
    if (!site || site.userId !== session.user.id) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const crawls = await db.crawl.findMany({
      where: { siteId },
      orderBy: { startedAt: "desc" },
      take: 10,
      include: {
        issues: {
          where: visibleIssueFilter(),
          take: 200,
          orderBy: { severity: "asc" },
        },
      },
    });

    return Response.json(crawls);
  } catch (error) {
    console.error(error);
    return Response.json({ error: "Failed to load crawls" }, { status: 500 });
  }
}
