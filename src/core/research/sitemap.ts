import { XMLParser } from "fast-xml-parser";
import type { Fetcher } from "./http.ts";
import type { RobotsRules } from "./robots.ts";

export interface SitemapEntry {
  loc: string;
  lastmod?: string;
}

const parser = new XMLParser({
  ignoreAttributes: true,
  isArray: (name) => name === "url" || name === "sitemap",
});

export function parseSitemap(xml: string): {
  kind: "index" | "urlset" | "unknown";
  entries: SitemapEntry[];
} {
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    return { kind: "unknown", entries: [] };
  }
  const index = doc.sitemapindex as { sitemap?: { loc?: string; lastmod?: string }[] } | undefined;
  if (index?.sitemap) {
    return {
      kind: "index",
      entries: index.sitemap
        .filter((s) => s.loc)
        .map((s) => ({
          loc: String(s.loc).trim(),
          lastmod: s.lastmod ? String(s.lastmod) : undefined,
        })),
    };
  }
  const urlset = doc.urlset as { url?: { loc?: string; lastmod?: string }[] } | undefined;
  if (urlset?.url) {
    return {
      kind: "urlset",
      entries: urlset.url
        .filter((u) => u.loc)
        .map((u) => ({
          loc: String(u.loc).trim(),
          lastmod: u.lastmod ? String(u.lastmod) : undefined,
        })),
    };
  }
  return { kind: "unknown", entries: [] };
}

const CANDIDATES = [
  "/sitemap.xml",
  "/sitemap_index.xml",
  "/sitemap-index.xml",
  "/sitemap.xml.gz",
  "/post-sitemap.xml",
  "/blog/sitemap.xml",
];

/** Discover sitemap URLs and collect every page entry, following index files up to two levels. */
export async function collectSitemapEntries(
  fetcher: Fetcher,
  siteUrl: string,
  robots: RobotsRules | undefined,
  opts: { maxSitemaps?: number; errors?: string[] } = {},
): Promise<{ sitemapUrls: string[]; entries: SitemapEntry[] }> {
  const origin = new URL(siteUrl).origin;
  const queue = [...(robots?.sitemaps ?? []), ...CANDIDATES.map((c) => origin + c)];
  const seen = new Set<string>();
  const sitemapUrls: string[] = [];
  const entries = new Map<string, SitemapEntry>();
  const max = opts.maxSitemaps ?? 25;
  let found = false;
  while (queue.length && sitemapUrls.length < max) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    // Once a sitemap was found via robots or a candidate, stop trying remaining guesses.
    if (
      found &&
      CANDIDATES.some((c) => url === origin + c) &&
      !(robots?.sitemaps ?? []).includes(url)
    )
      continue;
    let res: Awaited<ReturnType<Fetcher["get"]>>;
    try {
      res = await fetcher.get(url);
    } catch (err) {
      opts.errors?.push((err as Error).message);
      continue;
    }
    if (
      res.status !== 200 ||
      (!/xml|gzip|octet-stream|text\/plain/.test(res.contentType) &&
        !res.text.trimStart().startsWith("<"))
    )
      continue;
    const parsed = parseSitemap(res.text);
    if (parsed.kind === "unknown") continue;
    found = true;
    sitemapUrls.push(url);
    if (parsed.kind === "index") {
      for (const e of parsed.entries) if (!seen.has(e.loc)) queue.unshift(e.loc);
    } else {
      for (const e of parsed.entries) if (!entries.has(e.loc)) entries.set(e.loc, e);
    }
  }
  return { sitemapUrls, entries: [...entries.values()] };
}
