import { entryKey } from "../analysis/links.ts";
import type { CmsConfig, CollectionConfig } from "../config/schema.ts";
import type { Entry } from "../content/schema.ts";
import {
  type MarkdownAnalysis,
  renderHtml,
  type TocItem,
  tableOfContents,
} from "../markdown/analyze.ts";
import { buildJsonLd, type JsonLd } from "../metadata/jsonld.ts";
import { nowIso } from "../util/dates.ts";
import { slugify } from "../util/text.ts";
import { SERVER_VERSION } from "../version.ts";
import type { ThemeTokens } from "./theme.ts";

export type PageKind = "home" | "entry" | "collection" | "term" | "taxonomy" | "404";

export interface TermLink {
  name: string;
  url: string;
  count?: number;
}

export interface EntrySummaryView {
  collection: string;
  kind: CollectionConfig["kind"];
  slug: string;
  path: string;
  url: string;
  title: string;
  status: string;
  description?: string;
  excerpt?: string;
  image?: string;
  imageAlt?: string;
  publishedAt?: string;
  updatedAt?: string;
  author?: string;
  category?: string;
  categoryUrl?: string;
  tags: string[];
  tagLinks: TermLink[];
  readingTime?: number;
  wordCount?: number;
}

export interface EntryView extends EntrySummaryView {
  html: string;
  text: string;
  toc: TocItem[];
  headings: MarkdownAnalysis["headings"];
  seo: Record<string, unknown>;
  social: Record<string, unknown>;
  aeo: {
    answer?: string;
    keyTakeaways: string[];
    faq: { question: string; answer: string }[];
    questions: string[];
  };
  /** True when aeo.answer is (nearly) the opening paragraph, so themes avoid showing it twice. */
  answerIsLead: boolean;
  sources: string[];
  related: string[];
  language?: string;
  canonical?: string;
  jsonld: JsonLd;
  custom: Record<string, unknown>;
}

export interface SiteView {
  name: string;
  url: string;
  description: string;
  language: string;
  nav: { label: string; url: string }[];
  dataPath: string;
  searchCollection: string;
  feeds: boolean;
  llmsTxt: boolean;
  social: CmsConfig["site"]["social"];
  organization?: CmsConfig["site"]["organization"];
}

export interface Pagination {
  page: number;
  totalPages: number;
  perPage: number;
  total: number;
  prevUrl?: string;
  nextUrl?: string;
  pages: { number: number; url: string }[];
}

export interface RenderContext {
  site: SiteView;
  theme: ThemeTokens;
  page: {
    kind: PageKind;
    title: string;
    description?: string;
    path: string;
    url: string;
    language?: string;
  };
  entry?: EntryView;
  author?: EntrySummaryView & { description?: string };
  related?: EntrySummaryView[];
  entries?: EntrySummaryView[];
  pagination?: Pagination;
  collection?: { name: string; label: string; description?: string; url: string; kind: string };
  term?: { kind: "tag" | "category"; name: string; url: string; count: number };
  terms?: TermLink[];
  taxonomy: { categories: TermLink[]; tags: TermLink[] };
  assets: Record<string, string>;
  head: string;
  build: { generatedAt: string; year: number; version: string };
}

export interface SiteModel {
  config: CmsConfig;
  site: SiteView;
  theme: ThemeTokens;
  views: Map<string, EntryView>;
  visible: EntryView[];
  byCollection: Map<string, EntryView[]>;
  taxonomy: { categories: TermLink[]; tags: TermLink[] };
  collectionBase: Map<string, string | undefined>;
}

function sameText(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const x = norm(a);
  const y = norm(b);
  return x === y || x.startsWith(y) || y.startsWith(x);
}

export function collectionBasePath(collection: CollectionConfig): string | undefined {
  const base = collection.urlPattern.split("{")[0]!.replace(/\/+$/, "");
  return base ? `${base}/` : undefined;
}

export function termUrl(config: CmsConfig, kind: "tag" | "category", name: string): string {
  const root = kind === "tag" ? config.build.html.tagsPath : config.build.html.categoriesPath;
  return `${root.replace(/\/+$/, "")}/${slugify(name)}/`;
}

export function summarize(view: EntryView): EntrySummaryView {
  const {
    html: _h,
    text: _t,
    toc: _toc,
    headings: _hd,
    jsonld: _j,
    custom: _c,
    seo: _s,
    social: _so,
    aeo: _a,
    sources: _src,
    related: _r,
    ...summary
  } = view;
  return summary;
}

export async function buildSiteModel(input: {
  config: CmsConfig;
  entries: Entry[];
  analyses: Map<string, MarkdownAnalysis>;
  theme: ThemeTokens;
  includeDrafts?: boolean;
}): Promise<SiteModel> {
  const { config } = input;
  const includeDrafts = input.includeDrafts ?? config.build.includeDrafts;
  const collections = new Map(config.collections.map((c) => [c.name, c]));
  const authors = new Map(
    input.entries
      .filter((e) => collections.get(e.collection)?.kind === "author")
      .map((e) => [e.slug, e]),
  );
  const views = new Map<string, EntryView>();
  for (const entry of input.entries) {
    if (!includeDrafts && entry.frontmatter.status !== "published") continue;
    const collection = collections.get(entry.collection)!;
    const analysis = input.analyses.get(entryKey(entry));
    if (!analysis) continue;
    const fm = entry.frontmatter;
    const custom: Record<string, unknown> = {};
    for (const f of collection.fields) custom[f.name] = (fm as Record<string, unknown>)[f.name];
    views.set(entryKey(entry), {
      collection: entry.collection,
      kind: collection.kind,
      slug: entry.slug,
      path: entry.path,
      url: entry.url,
      title: fm.title,
      status: fm.status,
      description: fm.seo?.description ?? fm.description,
      excerpt: fm.excerpt,
      image: fm.image,
      imageAlt: fm.imageAlt,
      publishedAt: fm.publishedAt,
      updatedAt: fm.updatedAt,
      author: fm.author,
      category: fm.category,
      categoryUrl: fm.category ? termUrl(config, "category", fm.category) : undefined,
      tags: fm.tags,
      tagLinks: fm.tags.map((t) => ({ name: t, url: termUrl(config, "tag", t) })),
      readingTime: fm.readingTime,
      wordCount: fm.wordCount ?? analysis.wordCount,
      html: await renderHtml(entry.body),
      text: analysis.text,
      toc: tableOfContents(analysis.headings),
      headings: analysis.headings,
      seo: (fm.seo ?? {}) as Record<string, unknown>,
      social: (fm.social ?? {}) as Record<string, unknown>,
      aeo: {
        answer: fm.aeo?.answer,
        keyTakeaways: fm.aeo?.keyTakeaways ?? [],
        faq: fm.aeo?.faq ?? [],
        questions: fm.aeo?.questions ?? [],
      },
      answerIsLead: sameText(fm.aeo?.answer, analysis.firstParagraph),
      sources: fm.sources ?? [],
      related: fm.related ?? [],
      language: fm.language,
      canonical: fm.canonical,
      jsonld: buildJsonLd(entry, analysis, {
        config,
        collection,
        author: fm.author ? authors.get(fm.author) : undefined,
      }),
      custom,
    });
  }
  const visible = [...views.values()].sort((a, b) =>
    (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""),
  );
  const byCollection = new Map<string, EntryView[]>();
  for (const v of visible)
    byCollection.set(v.collection, [...(byCollection.get(v.collection) ?? []), v]);
  const collectionBase = new Map(config.collections.map((c) => [c.name, collectionBasePath(c)]));

  const catCounts = new Map<string, number>();
  const tagCounts = new Map<string, number>();
  for (const v of visible) {
    if (!collections.get(v.collection)?.listable) continue;
    if (v.category) catCounts.set(v.category, (catCounts.get(v.category) ?? 0) + 1);
    for (const t of v.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  }
  const taxonomy = {
    categories: [...catCounts]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count, url: termUrl(config, "category", name) })),
    tags: [...tagCounts]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count, url: termUrl(config, "tag", name) })),
  };

  const postCollection =
    config.collections.find((c) => c.kind === "post") ??
    config.collections.find((c) => c.listable) ??
    config.collections[0]!;
  const nav = config.build.html.nav ?? [
    { label: "Home", url: "/" },
    ...config.collections
      .filter((c) => c.listable && c.kind !== "author" && collectionBase.get(c.name))
      .map((c) => ({ label: c.label ?? c.name, url: collectionBase.get(c.name)! })),
    ...visible
      .filter((v) => v.kind === "page")
      .slice(0, 5)
      .map((v) => ({ label: v.title, url: v.path })),
  ];
  const site: SiteView = {
    name: config.site.name,
    url: config.site.url,
    description: config.site.description,
    language: config.site.language,
    nav,
    dataPath: `/${config.build.dataPath.replace(/^\/+|\/+$/g, "")}`,
    searchCollection: postCollection.name,
    feeds: config.build.feeds,
    llmsTxt: config.build.llmsTxt,
    social: config.site.social,
    organization: config.site.organization,
  };
  return {
    config,
    site,
    theme: input.theme,
    views,
    visible,
    byCollection,
    taxonomy,
    collectionBase,
  };
}

export function baseContext(
  model: SiteModel,
  assets: Record<string, string>,
): Omit<RenderContext, "page" | "head"> {
  return {
    site: model.site,
    theme: model.theme,
    taxonomy: model.taxonomy,
    assets,
    build: { generatedAt: nowIso(), year: new Date().getFullYear(), version: SERVER_VERSION },
  };
}
