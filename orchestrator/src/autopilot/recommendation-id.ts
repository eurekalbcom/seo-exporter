import { createHash } from "node:crypto";

export function recommendationId(domain: string, rule: string, subject: string): string {
  const digest = createHash("sha256").update(`${domain}\n${rule}\n${subject}`).digest("hex").slice(0, 12);
  return `rec_${digest}`;
}
