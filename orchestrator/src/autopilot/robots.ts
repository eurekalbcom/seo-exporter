export type RobotsRule = { allow: boolean; path: string };
export type RobotsGroup = { agents: string[]; rules: RobotsRule[]; crawlDelay: number | null };

export type ParsedRobots = {
  groups: RobotsGroup[];
  sitemaps: string[];
};

function stripComment(line: string): string {
  const mark = line.indexOf("#");
  return (mark < 0 ? line : line.slice(0, mark)).trim();
}

export function parseRobots(text: string): ParsedRobots {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let seenRule = false;
  for (const raw of text.split(/\r\n|\n|\r/)) {
    const line = stripComment(raw);
    if (line === "" && raw.includes("#")) continue;
    if (!line) {
      current = null;
      seenRule = false;
      continue;
    }
    const split = line.indexOf(":");
    if (split < 0) continue;
    const field = line.slice(0, split).trim().toLowerCase();
    const value = line.slice(split + 1).trim();
    if (field === "user-agent") {
      if (!current || seenRule) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
        seenRule = false;
      }
      if (value) current.agents.push(value);
      continue;
    }
    if (field === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (!current) continue;
    seenRule = true;
    if (field === "allow" && value) current.rules.push({ allow: true, path: value });
    if (field === "disallow" && value) current.rules.push({ allow: false, path: value });
    if (field === "crawl-delay") {
      const delay = Number(value);
      if (Number.isFinite(delay) && delay >= 0) current.crawlDelay = delay;
    }
  }
  return { groups, sitemaps };
}

function agentScore(agent: string, userAgent: string): number {
  if (agent === "*") return 0;
  return userAgent.toLowerCase().includes(agent.toLowerCase()) ? agent.length : -1;
}

export function selectedGroups(parsed: ParsedRobots, userAgent: string): RobotsGroup[] {
  let best = -1;
  for (const group of parsed.groups) {
    for (const agent of group.agents) {
      best = Math.max(best, agentScore(agent, userAgent));
    }
  }
  if (best < 0) return [];
  return parsed.groups.filter((group) => group.agents.some((agent) => agentScore(agent, userAgent) === best));
}

function ruleRegex(pattern: string): RegExp {
  let source = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] ?? "";
    if (ch === "*") {
      source += ".*";
    } else if (ch === "$" && i === pattern.length - 1) {
      source += "$";
    } else {
      source += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  if (!pattern.endsWith("$")) source += ".*";
  return new RegExp(source);
}

export function robotsAllows(parsed: ParsedRobots, url: string, userAgent: string): boolean {
  const pathname = new URL(url).pathname || "/";
  const groups = selectedGroups(parsed, userAgent);
  let winner: { allow: boolean; length: number } | null = null;
  for (const group of groups) {
    for (const rule of group.rules) {
      if (!ruleRegex(rule.path).test(pathname)) continue;
      const length = rule.path.length;
      if (!winner || length > winner.length || (length === winner.length && rule.allow && !winner.allow)) {
        winner = { allow: rule.allow, length };
      }
    }
  }
  return winner ? winner.allow : true;
}

export function robotsCrawlDelay(parsed: ParsedRobots, userAgent: string): number | null {
  const groups = selectedGroups(parsed, userAgent);
  for (const group of groups) {
    if (group.crawlDelay !== null) return group.crawlDelay;
  }
  return null;
}
