import * as cheerio from "cheerio";
import { KeywordIndex } from "../analysis/keywords.ts";
import type { ResearchConfig } from "../config/schema.ts";
import { nowIso } from "../util/dates.ts";
import { log } from "../util/log.ts";
import { extractPage, pageText } from "./extract.ts";
import { Fetcher } from "./http.ts";
import { isAllowed, parseRobots, type RobotsRules } from "./robots.ts";
import { collectSitemapEntries } from "./sitemap.ts";
import type { PageRecord, SiteSnapshot } from "./types.ts";

export interface CrawlOptions {
  url: string;
  config: ResearchConfig;
  fetchImpl?: typeof fetch;
  maxPages?: number;
  onProgress?: (msg: string) => void;
}

const SKIP_PATH = /\.(png|jpe?g|gif|svg|webp|pdf|zip|css|js|xml|json|txt|mp4|mp3)$/i;
const SKIP_SEGMENT =
  /\/(tag|tags|category|categories|author|authors|page|wp-content|wp-json|feed|search|cart|checkout|login|signup|privacy|terms)(\/|$)/i;

export async function crawlSite(opts: CrawlOptions): Promise<SiteSnapshot> {
  const { config } = opts;
  const base = new URL(opts.url);
  const origin = base.origin;
  const fetcher = new Fetcher({
    userAgent: config.userAgent,
    delayMs: config.requestDelayMs,
    fetchImpl: opts.fetchImpl,
  });
  const errors: string[] = [];
  const progress = opts.onProgress ?? ((m: string) => log.info(m));
  const maxPages = opts.maxPages ?? config.maxPagesPerSite;

  let robots: RobotsRules | undefined;
  try {
    const res = await fetcher.get(`${origin}/robots.txt`);
    if (res.status === 200) robots = parseRobots(res.text);
  } catch (err) {
    errors.push(`robots.txt: ${(err as Error).message}`);
  }
  const allowed = (p: string) => !robots || isAllowed(robots, config.userAgent, p);

  progress(`Discovering sitemaps for ${base.host}`);
  const { sitemapUrls, entries } = await collectSitemapEntries(fetcher, origin, robots, { errors });
  const prefixes = config.pathPrefixes.length
    ? config.pathPrefixes
    : base.pathname !== "/"
      ? [base.pathname]
      : [];
  let candidates = entries
    .filter((e) => sameHost(e.loc, base.host))
    .filter((e) => !SKIP_PATH.test(e.loc) && !SKIP_SEGMENT.test(new URL(e.loc).pathname))
    .filter(
      (e) => prefixes.length === 0 || prefixes.some((p) => new URL(e.loc).pathname.startsWith(p)),
    )
    .sort((a, b) => (b.lastmod ?? "").localeCompare(a.lastmod ?? ""));
  let discovered = candidates.length;

  if (candidates.length === 0) {
    progress("No sitemap found; falling back to homepage links");
    try {
      const home = await fetcher.get(opts.url);
      const $ = cheerio.load(home.text);
      const links = new Set<string>();
      $("a[href]").each((_, el) => {
        try {
          const u = new URL($(el).attr("href") ?? "", home.finalUrl);
          u.hash = "";
          u.search = "";
          if (u.host !== base.host || SKIP_PATH.test(u.pathname) || SKIP_SEGMENT.test(u.pathname))
            return;
          if (prefixes.length && !prefixes.some((p) => u.pathname.startsWith(p))) return;
          if (u.pathname === "/" || u.pathname === base.pathname) return;
          links.add(u.toString());
        } catch {
          // ignore bad hrefs
        }
      });
      candidates = [...links].map((loc) => ({ loc }));
      discovered = candidates.length;
    } catch (err) {
      errors.push(`homepage: ${(err as Error).message}`);
    }
  }

  const pages: PageRecord[] = [];
  const texts = new Map<string, string>();
  for (const c of candidates.slice(0, maxPages)) {
    const p = new URL(c.loc).pathname;
    if (!allowed(p)) {
      errors.push(`robots disallows ${p}`);
      continue;
    }
    try {
      const res = await fetcher.get(c.loc);
      if (res.status !== 200 || !res.contentType.includes("html")) continue;
      const page = extractPage(res.text, res.finalUrl || c.loc);
      if (!page.publishedAt && c.lastmod) page.modifiedAt = page.modifiedAt ?? c.lastmod;
      pages.push(page);
      texts.set(page.url, pageText(res.text));
      progress(
        `Fetched ${pages.length}/${Math.min(maxPages, candidates.length)}: ${page.title ?? page.url}`,
      );
    } catch (err) {
      errors.push((err as Error).message);
    }
  }

  const corpus = pages.map((p) => ({
    id: p.url,
    title: p.title ?? p.h1,
    headings: [...p.h2, ...p.h3],
    text: texts.get(p.url) ?? "",
  }));
  const index = new KeywordIndex(corpus);
  for (const doc of corpus) {
    const page = pages.find((p) => p.url === doc.id)!;
    page.keywords = index.extract(doc, 8).map((k) => k.phrase);
  }

  let name: string | undefined;
  try {
    const homeTitle = pages.find((p) => new URL(p.url).pathname === "/")?.title;
    name = homeTitle?.split(/[|–-]/)[0]?.trim();
  } catch {
    // ignore
  }

  return {
    host: base.host,
    url: opts.url,
    name,
    fetchedAt: nowIso(),
    sitemapUrls,
    discovered,
    pages,
    errors: errors.slice(0, 20),
  };
}

function sameHost(url: string, host: string): boolean {
  try {
    return new URL(url).host === host;
  } catch {
    return false;
  }
}
