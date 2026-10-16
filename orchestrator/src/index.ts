import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { triggerJob, type TriggerJob } from "./client";
import { loadScheduledDomains } from "./domains";
import { proposeRecommendation, type Recommendation } from "./recommendations";
import { jobAt, type JobName } from "./schedule";

export type AuditEvent = {
  actor: string;
  action: string;
  domain: string;
  details: Record<string, unknown>;
};

export type OrchestratorDeps = {
  domainsFile: string;
  env?: NodeJS.ProcessEnv;
  trigger: (input: { job: TriggerJob; domain: string }) => Promise<void>;
  saveRecommendations: (rows: Recommendation[]) => Promise<void>;
  audit: (event: AuditEvent) => Promise<void>;
  analyze?: (domain: string) => Recommendation[];
};

const here = dirname(fileURLToPath(import.meta.url));

export function defaultDomainsFile(): string {
  return join(here, "../config/domains.yml");
}

/** One minute tick. Analysis stores proposed rows and an audit line. It does not execute them. */
export async function tick(now: Date, deps: OrchestratorDeps): Promise<JobName | null> {
  const job = jobAt(now);
  if (!job) return null;
  const domains = loadScheduledDomains(deps.domainsFile, deps.env);
  for (const domain of domains) {
    switch (job) {
      case "gsc-sync":
      case "crawl":
      case "vitals":
        await deps.trigger({ job, domain });
        break;
      case "analysis": {
        const rows = (deps.analyze ?? defaultAnalyze)(domain);
        await deps.saveRecommendations(rows);
        await deps.audit({
          actor: "orchestrator",
          action: "analysis",
          domain,
          details: { recommendations: rows.length, executed: false },
        });
        break;
      }
      default: {
        const _never: never = job;
        return _never;
      }
    }
  }
  return job;
}

function defaultAnalyze(domain: string): Recommendation[] {
  return [
    proposeRecommendation({
      domain,
      category: "gsc_bing_settings",
      description: "Review Search Console property access",
      rationale: "Read-only check recorded for a human. Nothing is changed.",
      data: { source: "schedule" },
      risk: "No change is applied.",
      rollback: "No change was applied.",
      impact: 2,
      effort: 1,
    }),
  ];
}

export { triggerJob };
