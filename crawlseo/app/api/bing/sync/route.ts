import { auth } from "@/lib/auth";
import { redactError } from "@/lib/bing/redact-url";
import { db } from "@/lib/db";
import { isBingEnabled } from "@/lib/flags";
import { syncBingDataForSite } from "@/lib/workers/bing-sync";

export async function POST(req: Request) {
  if (!isBingEnabled()) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const session = await auth();

    if (!session?.user?.id) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { siteId } = (await req.json()) as { siteId?: string };
    if (!siteId) {
      return Response.json({ error: "Missing siteId" }, { status: 400 });
    }

    // Same answer as /api/gsc/sync for a site that does not exist and for one
    // that belongs to someone else, so the status does not say which ids exist.
    const site = await db.site.findUnique({
      where: { id: siteId },
      select: { userId: true, bingSite: true },
    });

    if (!site || site.userId !== session.user.id) {
      return Response.json(
        { error: "Site not found or unauthorized" },
        { status: 404 }
      );
    }

    if (!site.bingSite) {
      return Response.json(
        { error: "Site does not have a Bing Webmaster property connected" },
        { status: 400 }
      );
    }

    const result = await syncBingDataForSite(session.user.id, siteId);

    if (!result.success) {
      return Response.json(result, { status: 400 });
    }

    return Response.json(result);
  } catch (error) {
    console.error("Bing sync error:", redactError(error));

    return Response.json(
      { error: "Bing sync failed" },
      { status: 500 }
    );
  }
}
