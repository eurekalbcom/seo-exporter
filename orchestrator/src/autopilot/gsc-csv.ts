export type GscMetrics = {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

export type GscQueryRow = GscMetrics & { query: string };
export type GscPageRow = GscMetrics & { page: string };

const QUERY_HEADERS = new Set(["query", "top queries", "zapytanie", "najpopularniejsze zapytania"]);
const PAGE_HEADERS = new Set(["page", "top pages", "landing page", "strona", "najpopularniejsze strony"]);

function normHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

export function parseCsvTable(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i] ?? "";
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function headerIndex(headers: string[], names: Set<string>): number {
  return headers.findIndex((header) => names.has(header));
}

function findHeader(rows: string[][]): { kind: "queries" | "pages"; index: number; headers: string[] } {
  for (let index = 0; index < rows.length; index++) {
    const headers = (rows[index] ?? []).map(normHeader);
    const hasMetrics =
      headers.includes("clicks") ||
      headers.includes("klikniecia") ||
      headers.includes("impressions") ||
      headers.includes("wyswietlenia");
    if (!hasMetrics) continue;
    const kind = headerIndex(headers, QUERY_HEADERS) >= 0
      ? "queries"
      : headerIndex(headers, PAGE_HEADERS) >= 0
        ? "pages"
        : null;
    if (kind) return { kind, index, headers };
  }
  throw new Error("Search Console CSV is missing a queries or pages header row");
}

function column(headers: string[], names: string[]): number {
  const index = headers.findIndex((header) => names.includes(header));
  if (index < 0) throw new Error(`Search Console CSV is missing a ${names[0]} column`);
  return index;
}

function parseCount(raw: string, label: string): number {
  const value = Number(raw.trim().replace(/[\s\u00a0]/g, "").replace(",", ""));
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid ${label}: ${raw}`);
  }
  return value;
}

function parseCtr(raw: string): number {
  const trimmed = raw.trim().replace(/\s/g, "");
  const percent = trimmed.endsWith("%");
  const value = Number(trimmed.replace("%", "").replace(",", "."));
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid CTR: ${raw}`);
  if (percent || value > 1) return value / 100;
  return value;
}

function parsePosition(raw: string): number {
  const value = Number(raw.trim().replace(",", "."));
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid position: ${raw}`);
  return value;
}

function metricsAt(row: string[], headers: string[]): GscMetrics {
  return {
    clicks: parseCount(row[column(headers, ["clicks", "klikniecia"])] ?? "", "clicks"),
    impressions: parseCount(row[column(headers, ["impressions", "wyswietlenia"])] ?? "", "impressions"),
    ctr: parseCtr(row[column(headers, ["ctr"])] ?? ""),
    position: parsePosition(row[column(headers, ["position", "pozycja"])] ?? ""),
  };
}

export function parseGscQueries(text: string): GscQueryRow[] {
  const table = parseCsvTable(text);
  const header = findHeader(table);
  if (header.kind !== "queries") throw new Error("Expected a Search Console queries export");
  const key = headerIndex(header.headers, QUERY_HEADERS);
  const rows: GscQueryRow[] = [];
  for (const row of table.slice(header.index + 1)) {
    const query = (row[key] ?? "").trim();
    if (!query) continue;
    rows.push({ query, ...metricsAt(row, header.headers) });
  }
  return rows;
}

export function parseGscPages(text: string): GscPageRow[] {
  const table = parseCsvTable(text);
  const header = findHeader(table);
  if (header.kind !== "pages") throw new Error("Expected a Search Console pages export");
  const key = headerIndex(header.headers, PAGE_HEADERS);
  const rows: GscPageRow[] = [];
  for (const row of table.slice(header.index + 1)) {
    const page = (row[key] ?? "").trim();
    if (!page) continue;
    rows.push({ page, ...metricsAt(row, header.headers) });
  }
  return rows;
}
