/** Keep a query on one Markdown list line. CommonMark punctuation is escaped. */
export function escapeMarkdownInline(value: string): string {
  return value.replace(/\r\n|\n|\r/g, " ").replace(/[\\`*_{}[\]()#+.!|-]/g, (char) => `\\${char}`);
}
