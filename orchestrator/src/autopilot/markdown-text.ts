/** Keep query and page text on one Markdown list line. */
export function escapeMarkdownInline(value: string): string {
  return value
    .replace(/\r\n|\n|\r/g, " ")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_{}[\]()#+.!|-]/g, (char) => `\\${char}`);
}
