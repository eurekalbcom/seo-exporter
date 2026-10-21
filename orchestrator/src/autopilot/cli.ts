import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { appendDecision, readDecisions } from "./approval";
import { crawlOrigins, hostOf, LIVE_ORIGINS, type FetchLike } from "./crawl";
import { REQUEST_TIMEOUT_MS } from "./safe-http";
import { loadFixtureSite } from "./fixture-site";
import { parseGscPages, parseGscQueries } from "./gsc-csv";
import { recommend } from "./recommend";
import { readReport, withDecisions, writeReport, type ReportMode } from "./report";

export type CliIo = {
  env?: NodeJS.ProcessEnv;
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
  fetchImpl?: FetchLike;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
};

type Command = "report" | "approve" | "reject" | "help";

const BOOLEAN_FLAGS = new Set(["live", "help"]);

function usage(): string {
  return [
    "Usage:",
    "  autopilot report --domain <host> --queries <csv> --pages <csv> --out <dir> (--fixture <dir> | --live)",
    "  autopilot approve <id> --report <report.json> --log <decisions.jsonl> [--actor <name>]",
    "  autopilot reject <id> --report <report.json> --log <decisions.jsonl> [--actor <name>]",
    "",
    `Live crawl fetches only ${LIVE_ORIGINS.join(" and ")}.`,
    "Search Console input is a CSV exported by hand. There is no Google API call.",
    "",
  ].join("\n");
}

function parseArgv(argv: string[]): { command: Command; flags: Map<string, string>; id?: string } {
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index] ?? "";
    if (token === "--") continue;
    if (token.startsWith("--")) {
      const key = token.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        flags.set(key, "true");
        continue;
      }
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
      flags.set(key, value);
      index += 1;
      continue;
    }
    positionals.push(token);
  }
  if (flags.get("help") === "true" || positionals.length === 0) {
    return { command: "help", flags };
  }
  const name = positionals[0];
  if (name !== "report" && name !== "approve" && name !== "reject" && name !== "help") {
    throw new Error(`Unknown command ${name}`);
  }
  return { command: name, flags, id: positionals[1] };
}

function required(flags: Map<string, string>, key: string): string {
  const value = flags.get(key);
  if (!value) throw new Error(`Missing --${key}`);
  return value;
}

function liveOrigin(domain: string): string {
  const match = LIVE_ORIGINS.find((origin) => hostOf(origin) === hostOf(`https://${domain}`));
  if (!match) throw new Error(`Live crawl only fetches ${LIVE_ORIGINS.join(" and ")}`);
  return match;
}

async function buildReport(flags: Map<string, string>, io: CliIo): Promise<number> {
  const stdout = io.stdout ?? ((chunk: string) => process.stdout.write(chunk));
  const domain = required(flags, "domain");
  const queries = parseGscQueries(readFileSync(required(flags, "queries"), "utf8"));
  const pages = parseGscPages(readFileSync(required(flags, "pages"), "utf8"));
  const fixture = flags.get("fixture");
  const live = flags.get("live") === "true";
  if (Boolean(fixture) === live) throw new Error("Pass either --fixture or --live");
  const env = io.env ?? process.env;
  let mode: ReportMode;
  let origins: string[];
  let fetchImpl: FetchLike;
  let minDelayMs: number | undefined;
  if (fixture) {
    const site = loadFixtureSite(fixture);
    if (hostOf(site.origin) !== hostOf(`https://${domain}`)) {
      throw new Error(`Fixture origin ${site.origin} does not match ${domain}`);
    }
    mode = "fixture";
    origins = [site.origin];
    fetchImpl = site.fetchImpl;
    minDelayMs = 0;
  } else {
    mode = "live";
    origins = [liveOrigin(domain)];
    fetchImpl = io.fetchImpl ?? fetch;
    minDelayMs = undefined;
  }
  const crawl = await crawlOrigins({
    origins,
    fetchImpl,
    env,
    minDelayMs,
    sleep: io.sleep,
    timeoutMs: io.timeoutMs ?? REQUEST_TIMEOUT_MS,
  });
  const report = {
    generatedAt: (io.now ?? (() => new Date()))().toISOString(),
    domain,
    mode,
    recommendations: recommend({ domain, crawl, queries, pages }),
    crawl,
    queries,
    pages,
  };
  const written = writeReport(required(flags, "out"), report);
  stdout(`${written.jsonPath}\n${written.markdownPath}\n`);
  return 0;
}

function decide(command: "approve" | "reject", id: string | undefined, flags: Map<string, string>, io: CliIo): number {
  const stdout = io.stdout ?? ((chunk: string) => process.stdout.write(chunk));
  if (!id) throw new Error("Missing recommendation id");
  const reportPath = required(flags, "report");
  const logPath = required(flags, "log");
  if (resolve(reportPath) === resolve(logPath)) {
    throw new Error("Decision log must be a different file from the report");
  }
  const report = readReport(reportPath);
  const match = report.recommendations.find((item) => item.id === id);
  if (!match) throw new Error(`Unknown recommendation ${id}`);
  const before = readFileSync(reportPath);
  appendDecision(logPath, {
    at: (io.now ?? (() => new Date()))().toISOString(),
    id,
    status: command === "approve" ? "approved" : "rejected",
    actor: flags.get("actor") ?? "operator",
  });
  const after = readFileSync(reportPath);
  if (!before.equals(after)) throw new Error("Decision log must not rewrite the report");
  const folded = withDecisions(report, readDecisions(logPath)).recommendations.find((item) => item.id === id);
  stdout(`${id} ${folded?.status ?? match.status}\n`);
  return 0;
}

export async function main(argv: string[], io: CliIo = {}): Promise<number> {
  const stderr = io.stderr ?? ((chunk: string) => process.stderr.write(chunk));
  try {
    const parsed = parseArgv(argv);
    switch (parsed.command) {
      case "help":
        (io.stdout ?? ((chunk: string) => process.stdout.write(chunk)))(usage());
        return 0;
      case "report":
        return await buildReport(parsed.flags, io);
      case "approve":
      case "reject":
        return decide(parsed.command, parsed.id, parsed.flags, io);
      default: {
        const unreachable: never = parsed.command;
        return unreachable;
      }
    }
  } catch (err) {
    stderr(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

const invoked = process.argv[1];
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
