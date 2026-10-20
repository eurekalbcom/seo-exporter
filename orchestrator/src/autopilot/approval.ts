import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RecommendationStatus } from "./recommend";

export type DecisionStatus = "approved" | "rejected";

export type Decision = {
  at: string;
  id: string;
  status: DecisionStatus;
  actor: string;
};

const ID_PATTERN = /^rec_[0-9a-f]{12}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseDecision(value: unknown): Decision {
  if (!isRecord(value)) throw new Error("Decision must be an object");
  const { at, id, status, actor } = value;
  if (typeof at !== "string" || Number.isNaN(Date.parse(at))) throw new Error("Decision at must be a timestamp");
  if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new Error("Decision id must be a recommendation id");
  if (status !== "approved" && status !== "rejected") throw new Error("Decision status must be approved or rejected");
  if (typeof actor !== "string" || actor.trim() === "" || actor.length > 80 || /[\r\n]/.test(actor)) {
    throw new Error("Decision actor must be a single line");
  }
  return { at, id, status, actor };
}

export function appendDecision(logPath: string, decision: Decision): void {
  const checked = parseDecision(decision);
  const line = `${JSON.stringify(checked)}\n`;
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, line, { encoding: "utf8", flag: "a" });
}

export function readDecisions(logPath: string): Decision[] {
  if (!existsSync(logPath)) return [];
  const text = readFileSync(logPath, "utf8");
  const decisions: Decision[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    decisions.push(parseDecision(JSON.parse(line) as unknown));
  }
  return decisions;
}

export function foldStatus(status: RecommendationStatus, decisions: Decision[]): RecommendationStatus {
  let current = status;
  for (const decision of decisions) {
    switch (decision.status) {
      case "approved":
      case "rejected":
        current = decision.status;
        break;
      default: {
        const unreachable: never = decision.status;
        return unreachable;
      }
    }
  }
  return current;
}
