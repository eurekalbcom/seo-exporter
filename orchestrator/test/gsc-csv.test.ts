import { describe, expect, it } from "vitest";
import { parseGscPages, parseGscQueries } from "../src/autopilot/gsc-csv";

const QUERIES = `\uFEFF# exported by hand from Search Console
Date range,2026-01-01,2026-01-31

Top queries,Clicks,Impressions,CTR,Position
"kolejka, wizyta",2,400,0.5%,8.2
marka,80,"1,000",80%,1.2
`;

describe("Search Console CSV", () => {
  it("parses a queries export with a preamble, a BOM, and quoted commas", () => {
    expect(parseGscQueries(QUERIES)).toEqual([
      { query: "kolejka, wizyta", clicks: 2, impressions: 400, ctr: 0.005, position: 8.2 },
      { query: "marka", clicks: 80, impressions: 1000, ctr: 0.8, position: 1.2 },
    ]);
  });

  it("parses Polish page headers and a ratio CTR", () => {
    const csv = "Najpopularniejsze strony,Kliknięcia,Wyświetlenia,CTR,Pozycja\nhttps://eurekalb.com/,3,500,0.006,9\n";
    expect(parseGscPages(csv)).toEqual([
      { page: "https://eurekalb.com/", clicks: 3, impressions: 500, ctr: 0.006, position: 9 },
    ]);
  });

  it("rejects a pages file passed as queries and a table with no header", () => {
    expect(() => parseGscQueries("Top pages,Clicks,Impressions,CTR,Position\nhttps://eurekalb.com/,1,1,1%,1\n")).toThrow(
      /queries export/
    );
    expect(() => parseGscPages("not,a,console,export\n")).toThrow(/header row/);
    expect(() => parseGscQueries("Top queries,Clicks,Impressions,CTR,Position\nx,nope,1,1%,1\n")).toThrow(/clicks/);
  });
});
