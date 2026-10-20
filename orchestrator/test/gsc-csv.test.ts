import { describe, expect, it } from "vitest";
import { parseGscPages, parseGscQueries } from "../src/autopilot/gsc-csv";

const QUERIES = `\uFEFF# exported by hand from Search Console
Date range,2026-01-01,2026-01-31

Top queries,Clicks,Impressions,CTR,Position
"example, query",3,150,1.5%,6.5
example query b,40,"1,000",70%,1.5
`;

describe("Search Console CSV", () => {
  it("parses a queries export with a preamble, a BOM, and quoted commas", () => {
    expect(parseGscQueries(QUERIES)).toEqual([
      { query: "example, query", clicks: 3, impressions: 150, ctr: 0.015, position: 6.5 },
      { query: "example query b", clicks: 40, impressions: 1000, ctr: 0.7, position: 1.5 },
    ]);
  });

  it("parses Polish page headers and a ratio CTR", () => {
    const csv = "Najpopularniejsze strony,Kliknięcia,Wyświetlenia,CTR,Pozycja\nhttps://example.com/,5,80,0.02,6\n";
    expect(parseGscPages(csv)).toEqual([
      { page: "https://example.com/", clicks: 5, impressions: 80, ctr: 0.02, position: 6 },
    ]);
  });

  it("parses counts with more than one thousands separator", () => {
    const csv = 'Top queries,Clicks,Impressions,CTR,Position\n"big","1,234,567","2,000,000",1%,4\n';
    expect(parseGscQueries(csv)).toEqual([
      { query: "big", clicks: 1234567, impressions: 2000000, ctr: 0.01, position: 4 },
    ]);
  });

  it("rejects a pages file passed as queries and a table with no header", () => {
    expect(() => parseGscQueries("Top pages,Clicks,Impressions,CTR,Position\nhttps://example.com/,1,1,1%,1\n")).toThrow(
      /queries export/
    );
    expect(() => parseGscPages("not,a,console,export\n")).toThrow(/header row/);
    expect(() => parseGscQueries("Top queries,Clicks,Impressions,CTR,Position\nx,nope,1,1%,1\n")).toThrow(/clicks/);
  });
});
