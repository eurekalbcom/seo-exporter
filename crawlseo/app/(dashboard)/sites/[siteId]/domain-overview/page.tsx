import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/page-header";
import { DomainOverviewClient } from "@/components/research/domain-overview-client";

interface Props {
  params: Promise<{ siteId: string }>;
}

export default async function DomainOverviewPage({ params }: Props) {
  const session = await auth();
  const { siteId } = await params;

  const site = await db.site.findUnique({
    where: { id: siteId },
    select: { userId: true, domain: true },
  });
  if (!site || site.userId !== session?.user?.id) redirect("/sites");

  return (
    <div>
      <PageHeader
        title="Domain overview"
        description="Search Console metrics for this site."
      />
      <DomainOverviewClient siteId={siteId} domain={site.domain} />
    </div>
  );
}
