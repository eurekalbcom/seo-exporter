# SEO Autopilot report

Domain: eurekalb.com
Generated: 2026-01-15T05:00:00.000Z
Mode: fixture
Recommendations: 14

Each recommendation starts as proposed. Approve or reject it in the decision log.
This tool does not change the site or Search Console.

## rec_00d7d9dd9d74

- status: proposed
- opis: Rewrite the title and description for https://example.com/
- uzasadnienie: The page has 300 impressions, CTR 0.6%, and average position 10.
- ryzyko: A snippet change can lower clicks if the new text matches the query worse.
- rollback: Restore the previous title and meta description. No change has been applied.
- dane:

````json
{
  "page": "https://example.com/",
  "clicks": 4,
  "impressions": 300,
  "ctr": 0.006,
  "position": 10
}
````

## rec_027ef1f3e7bd

- status: proposed
- opis: Rewrite the title and meta description on https://example.com/.
- uzasadnienie: CTR is 0.6% at position 10. The curve for that position is about 1.5%.
- ryzyko: A snippet that over-promises can earn the click and lose the visitor.
- rollback: Restore the previous title and meta description. No change has been applied.
- dane:

````json
{
  "page": "https://example.com/",
  "clicks": 4,
  "impressions": 300,
  "ctr": 0.006,
  "position": 10,
  "expectedCtr": 0.015,
  "maxCtrRatio": 0.5
}
````

## rec_305eeda6e49c

- status: proposed
- opis: Suggest a title, h1, and on-page section for "example query a".
- uzasadnienie: The query is at position 7.5 with 250 impressions, inside the striking-distance band.
- ryzyko: Changing the title, h1, or body can move rankings for other queries on the same URL.
- rollback: Restore the previous title, h1, and page text. No change has been applied.
- dane:

````json
{
  "query": "example query a",
  "clicks": 3,
  "impressions": 250,
  "ctr": 0.004,
  "position": 7.5,
  "page": null,
  "title": null,
  "h1": [],
  "thresholds": {
    "minPosition": 4,
    "maxPosition": 20,
    "minImpressions": 10
  }
}
````

## rec_50dbe95dd2af

- status: proposed
- opis: Add one h1 on https://eurekalb.com/about
- uzasadnienie: The page has no h1, so the main heading is not marked up.
- ryzyko: Changing the visible heading changes the page for every visitor.
- rollback: Restore the previous heading. No change has been applied.
- dane:

````json
{
  "url": "https://eurekalb.com/about",
  "h1": []
}
````

## rec_663bcedb74cd

- status: proposed
- opis: Keep a single h1 on https://eurekalb.com/guides
- uzasadnienie: The page has 2 h1 elements.
- ryzyko: Demoting a heading changes the outline visitors and parsers see.
- rollback: Restore the previous headings. No change has been applied.
- dane:

````json
{
  "url": "https://eurekalb.com/guides",
  "h1": [
    "First guide",
    "Second guide"
  ]
}
````

## rec_838144185c71

- status: proposed
- opis: Replace the redirect from https://eurekalb.com/old to https://eurekalb.com/about with a direct URL
- uzasadnienie: The crawler followed HTTP 301 from https://eurekalb.com/old to https://eurekalb.com/about.
- ryzyko: Removing a redirect breaks visitors and tools that still use the old URL.
- rollback: Restore the HTTP 301 redirect from https://eurekalb.com/old to https://eurekalb.com/about. No change has been applied.
- dane:

````json
{
  "from": "https://eurekalb.com/old",
  "to": "https://eurekalb.com/about",
  "status": 301
}
````

## rec_930ec698bbf4

- status: proposed
- opis: Add a title on https://eurekalb.com/blank
- uzasadnienie: The HTML title is empty, so search results have nothing specific to show.
- ryzyko: A new title changes the snippet searchers see.
- rollback: Restore the previous title element. No change has been applied.
- dane:

````json
{
  "url": "https://eurekalb.com/blank",
  "title": null
}
````

## rec_9358c5a2b866

- status: proposed
- opis: Rewrite the title and meta description for the query "example query a".
- uzasadnienie: CTR is 0.4% at position 7.5. The curve for that position is about 2.5%.
- ryzyko: A snippet that over-promises can earn the click and lose the visitor.
- rollback: Restore the previous title and meta description. No change has been applied.
- dane:

````json
{
  "query": "example query a",
  "clicks": 3,
  "impressions": 250,
  "ctr": 0.004,
  "position": 7.5,
  "expectedCtr": 0.025,
  "maxCtrRatio": 0.5
}
````

## rec_94120c6aa582

- status: proposed
- opis: Return HTTP 200 for sitemap URL https://eurekalb.com/ghost
- uzasadnienie: The sitemap lists this URL, and the crawl did not finish on HTTP 200.
- ryzyko: Changing the sitemap or the URL can remove a URL search engines already know.
- rollback: Restore the previous sitemap entry and the previous response. No change has been applied.
- dane:

````json
{
  "url": "https://eurekalb.com/ghost",
  "status": 404
}
````

## rec_9a245927f248

- status: proposed
- opis: Add a canonical link on https://eurekalb.com/about
- uzasadnienie: The page does not declare a canonical URL.
- ryzyko: A wrong canonical can drop the URL from search results.
- rollback: Remove the new canonical or restore the previous one. No change has been applied.
- dane:

````json
{
  "url": "https://eurekalb.com/about",
  "canonical": null
}
````

## rec_d99048d59b72

- status: proposed
- opis: Rewrite the title and description for the query "example query a"
- uzasadnienie: The query has 250 impressions, CTR 0.4%, and average position 7.5.
- ryzyko: A snippet change can lower clicks if the new text matches the query worse.
- rollback: Restore the previous title and meta description. No change has been applied.
- dane:

````json
{
  "query": "example query a",
  "clicks": 3,
  "impressions": 250,
  "ctr": 0.004,
  "position": 7.5
}
````

## rec_e04567e45c66

- status: proposed
- opis: Add a meta description on https://eurekalb.com/about
- uzasadnienie: The meta description is missing, so the result snippet is chosen from page text.
- ryzyko: A description that oversells the page can lower clicks after people land.
- rollback: Restore the previous meta description. No change has been applied.
- dane:

````json
{
  "url": "https://eurekalb.com/about",
  "metaDescription": null
}
````

## rec_f2f2e8208c42

- status: proposed
- opis: Fix the broken link from https://eurekalb.com/ to https://eurekalb.com/missing
- uzasadnienie: https://eurekalb.com/missing responded with HTTP 404.
- ryzyko: Replacing the link sends visitors to a different URL.
- rollback: Point the link back at https://eurekalb.com/missing. No change has been applied.
- dane:

````json
{
  "from": "https://eurekalb.com/",
  "to": "https://eurekalb.com/missing",
  "status": 404
}
````

## rec_fa39d0eff330

- status: proposed
- opis: Remove noindex from https://eurekalb.com/noindex
- uzasadnienie: The page asks crawlers not to index it.
- ryzyko: Removing noindex can make the URL eligible for search results.
- rollback: Put the noindex robots directive back. No change has been applied.
- dane:

````json
{
  "url": "https://eurekalb.com/noindex",
  "noindex": true
}
````
