import * as cheerio from "cheerio";
import { nowIso, toIso } from "../util/dates.ts";
import { countWords, isQuestion, normalizeWhitespace } from "../util/text.ts";
import type { PageRecord } from "./types.ts";

function collectSchemaTypes(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) collectSchemaTypes(v, out);
    return;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const t = obj["@type"];
    if (typeof t === "string") out.add(t);
    if (Array.isArray(t)) for (const x of t) if (typeof x === "string") out.add(x);
    for (const k of ["@graph", "mainEntity", "itemListElement"])
      if (obj[k]) collectSchemaTypes(obj[k], out);
  }
}

function findDate(json: unknown, key: "datePublished" | "dateModified"): string | undefined {
  if (Array.isArray(json)) {
    for (const j of json) {
      const d = findDate(j, key);
      if (d) return d;
    }
    return undefined;
  }
  if (json && typeof json === "object") {
    const obj = json as Record<string, unknown>;
    if (typeof obj[key] === "string") return obj[key] as string;
    if (obj["@graph"]) return findDate(obj["@graph"], key);
  }
  return undefined;
}

function findAuthor(json: unknown): string | undefined {
  if (Array.isArray(json)) {
    for (const j of json) {
      const a = findAuthor(j);
      if (a) return a;
    }
    return undefined;
  }
  if (json && typeof json === "object") {
    const obj = json as Record<string, unknown>;
    const a = obj.author as unknown;
    if (typeof a === "string") return a;
    if (a && typeof a === "object" && typeof (a as Record<string, unknown>).name === "string")
      return (a as Record<string, string>).name;
    if (Array.isArray(a) && a[0] && typeof a[0] === "object")
      return (a[0] as Record<string, string>).name;
    if (obj["@graph"]) return findAuthor(obj["@graph"]);
  }
  return undefined;
}

export function extractPage(html: string, url: string): PageRecord {
  const $ = cheerio.load(html);
  $("script:not([type='application/ld+json']), style, noscript, svg, iframe").remove();
  const meta = (sel: string) => $(sel).attr("content")?.trim() || undefined;
  const jsonLd: unknown[] = [];
  $("script[type='application/ld+json']").each((_, el) => {
    try {
      jsonLd.push(JSON.parse($(el).text()));
    } catch {
      // ignore malformed JSON-LD
    }
  });
  const schemaTypes = new Set<string>();
  for (const j of jsonLd) collectSchemaTypes(j, schemaTypes);

  const title =
    normalizeWhitespace(meta("meta[property='og:title']") ?? $("title").first().text() ?? "") ||
    undefined;
  const description = meta("meta[name='description']") ?? meta("meta[property='og:description']");
  const h1 = normalizeWhitespace($("h1").first().text()) || undefined;
  const h2 = $("h2")
    .map((_, el) => normalizeWhitespace($(el).text()))
    .get()
    .filter(Boolean);
  const h3 = $("h3")
    .map((_, el) => normalizeWhitespace($(el).text()))
    .get()
    .filter(Boolean);
  const main = $("main, article, [role='main']").first();
  const container = main.length ? main : $("body");
  container.find("nav, header, footer, aside, form, .sidebar, .nav, .menu, .comments").remove();
  const text = normalizeWhitespace(container.text());
  const host = safeHost(url);
  let internalLinks = 0;
  let externalLinks = 0;
  container.find("a[href]").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    if (/^(#|mailto:|tel:|javascript:)/i.test(href)) return;
    const linkHost = safeHost(href, url);
    if (!linkHost || linkHost === host) internalLinks++;
    else externalLinks++;
  });
  const publishedAt =
    toIso(meta("meta[property='article:published_time']")) ??
    toIso(meta("meta[name='date']")) ??
    toIso(meta("meta[name='pubdate']")) ??
    toIso(findDate(jsonLd, "datePublished")) ??
    toIso($("time[datetime]").first().attr("datetime"));
  const modifiedAt =
    toIso(meta("meta[property='article:modified_time']")) ??
    toIso(meta("meta[property='og:updated_time']")) ??
    toIso(findDate(jsonLd, "dateModified"));
  const author =
    meta("meta[name='author']") ??
    findAuthor(jsonLd) ??
    (normalizeWhitespace($("[rel='author'], .author, .byline").first().text()) || undefined);
  const headings = [h1 ?? "", ...h2, ...h3];
  const hasFaq =
    schemaTypes.has("FAQPage") ||
    headings.some((h) => /\b(faq|frequently asked questions)\b/i.test(h));
  return {
    url,
    path: safePath(url),
    title,
    description,
    h1,
    h2,
    h3,
    wordCount: countWords(text),
    publishedAt,
    modifiedAt,
    author,
    schemaTypes: [...schemaTypes],
    hasFaq,
    questionHeadings: headings.filter((h) => h && isQuestion(h)).length,
    ogImage: meta("meta[property='og:image']"),
    canonical: $("link[rel='canonical']").attr("href")?.trim() || undefined,
    lang: $("html").attr("lang")?.trim() || undefined,
    internalLinks,
    externalLinks,
    images: container.find("img").length,
    keywords: [],
    fetchedAt: nowIso(),
  };
}

export function pageText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, nav, header, footer, aside, form").remove();
  const main = $("main, article, [role='main']").first();
  return normalizeWhitespace((main.length ? main : $("body")).text());
}

function safeHost(href: string, base?: string): string | undefined {
  try {
    return new URL(href, base).host;
  } catch {
    return undefined;
  }
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
