export type PageExtract = {
  title: string | null;
  metaDescription: string | null;
  canonical: string | null;
  h1: string[];
  robotsMeta: string | null;
  noindex: boolean;
  links: string[];
};

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function visibleText(raw: string): string {
  return decodeEntities(raw.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function parseAttributes(tag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const body = tag.replace(/^<\s*[^\s/>]+\s*/, "").replace(/\/?\s*>$/, "");
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match = re.exec(body);
  while (match) {
    const name = (match[1] ?? "").toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (name && !attrs.has(name)) attrs.set(name, decodeEntities(value));
    match = re.exec(body);
  }
  return attrs;
}

function metaContent(html: string, name: string): string | null {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const attrs = parseAttributes(tag);
    const key = (attrs.get("name") ?? attrs.get("property") ?? "").toLowerCase();
    if (key === name) {
      const content = (attrs.get("content") ?? "").trim();
      return content || null;
    }
  }
  return null;
}

export function pageIsNoindex(robotsMeta: string | null, xRobotsTag: string | null): boolean {
  const blob = `${robotsMeta ?? ""}\n${xRobotsTag ?? ""}`;
  return /\bnoindex\b/i.test(blob) || /\bnone\b/i.test(blob);
}

export function extractHtml(html: string, pageUrl: string, xRobotsTag: string | null = null): PageExtract {
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? visibleText(titleMatch[1] ?? "") || null : null;
  const metaDescription = metaContent(html, "description");
  const robotsMeta = metaContent(html, "robots") ?? metaContent(html, "googlebot");
  const canonicalTag = (html.match(/<link\b[^>]*>/gi) ?? []).find((tag) => {
    const rel = parseAttributes(tag).get("rel") ?? "";
    return rel.toLowerCase().split(/\s+/).includes("canonical");
  });
  let canonical: string | null = null;
  if (canonicalTag) {
    const href = parseAttributes(canonicalTag).get("href")?.trim();
    if (href) {
      try {
        canonical = new URL(href, pageUrl).toString();
      } catch {
        canonical = null;
      }
    }
  }
  const h1 = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)]
    .map((match) => visibleText(match[1] ?? ""))
    .filter((text) => text.length > 0);
  const links: string[] = [];
  const seen = new Set<string>();
  for (const tag of html.match(/<a\b[^>]*>/gi) ?? []) {
    const href = parseAttributes(tag).get("href")?.trim();
    if (!href || href.startsWith("#") || /^(mailto:|tel:|javascript:)/i.test(href)) continue;
    let absolute: string;
    try {
      const url = new URL(href, pageUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      url.hash = "";
      absolute = url.toString();
    } catch {
      continue;
    }
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    links.push(absolute);
  }
  return {
    title,
    metaDescription,
    canonical,
    h1,
    robotsMeta,
    noindex: pageIsNoindex(robotsMeta, xRobotsTag),
    links,
  };
}
