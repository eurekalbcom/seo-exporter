// Runs once when the Next.js server starts.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build") {
    // Crawls left RUNNING by the previous server process (#57). Not awaited: a
    // slow database must not hold up the server, and the crawl guard and pages
    // apply the same rule on every request anyway.
    // Dynamic imports: this file is also evaluated for the edge runtime, which
    // cannot load the node-only guard, workers, or Prisma client.
    const { installFetchGuard } = await import("@/lib/write-mode");
    installFetchGuard();
    const { startOptionalWorkers } = await import("@/lib/workers/optional");
    startOptionalWorkers();
    const { db } = await import("@/lib/db");
    const { recoverCrawlsOnStartup } = await import("@/lib/crawler/lifecycle");
    void recoverCrawlsOnStartup(db);
  }
}
