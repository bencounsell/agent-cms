import path from "node:path";
import MiniSearch from "minisearch";
import type { CmsConfig, CollectionConfig } from "../config/schema.ts";
import type { Entry } from "../content/schema.ts";
import { type MarkdownAnalysis, renderHtml, tableOfContents } from "../markdown/analyze.ts";
import { buildJsonLd } from "../metadata/jsonld.ts";
import { nowIso } from "../util/dates.ts";
import {
  ensureDir,
  readJsonIfExists,
  remove,
  sha256,
  writeBuffer,
  writeJson,
  writeText,
} from "../util/fs.ts";

export interface BuildInput {
  root: string;
  config: CmsConfig;
  entries: Entry[];
  analyses: Map<string, MarkdownAnalysis>;
  outDir?: string;
  includeDrafts?: boolean;
  /** Extra outputs (rendered pages, assets) written through the same manifest-tracked writer. */
  extra?: (write: BuildWriter) => Promise<void>;
}

export type BuildWriter = (rel: string, content: string | Buffer) => Promise<void>;

export interface BuildManifest {
  generatedAt: string;
  outDir: string;
  entries: number;
  files: { path: string; bytes: number; hash: string }[];
  warnings: string[];
}

const key = (e: Entry) => `${e.collection}/${e.slug}`;

function escapeXml(s: string): string {
  return s.replace(
    /[<>&'"]/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!,
  );
}

/** Absolute URL of a file written at the site root. */
function rootUrl(config: CmsConfig, rel: string): string {
  return `${config.site.url.replace(/\/+$/, "")}/${rel}`;
}

/** Absolute URL of a file written under build.dataPath. */
function dataUrl(config: CmsConfig, rel: string): string {
  return rootUrl(config, `${dataRel(config, rel)}`);
}

/** Path of a data file relative to outDir. */
export function dataRel(config: CmsConfig, rel: string): string {
  const dp = config.build.dataPath.replace(/^\/+|\/+$/g, "");
  return dp ? `${dp}/${rel}` : rel;
}

export async function buildSite(input: BuildInput): Promise<BuildManifest> {
  const { config } = input;
  const outDir = path.resolve(input.root, input.outDir ?? config.build.outDir);
  const includeDrafts = input.includeDrafts ?? config.build.includeDrafts;
  const warnings: string[] = [];
  const files: BuildManifest["files"] = [];
  const written = new Set<string>();

  const write: BuildWriter = async (rel, content) => {
    const abs = path.join(outDir, rel);
    if (typeof content === "string") await writeText(abs, content);
    else await writeBuffer(abs, content);
    const text = typeof content === "string" ? content : content.toString("base64");
    files.push({
      path: rel,
      bytes: typeof content === "string" ? Buffer.byteLength(content) : content.length,
      hash: sha256(text).slice(0, 16),
    });
    written.add(rel);
  };

  await ensureDir(outDir);
  const manifestRel = dataRel(config, "manifest.json");
  const previous = await readJsonIfExists<BuildManifest>(path.join(outDir, manifestRel));

  const visible = input.entries.filter(
    (e) => includeDrafts || e.frontmatter.status === "published",
  );
  const authors = new Map(
    input.entries
      .filter((e) => config.collections.find((c) => c.name === e.collection)?.kind === "author")
      .map((e) => [e.slug, e]),
  );

  const collectionsOut: Record<string, unknown>[] = [];
  const searchDocs: Record<string, unknown>[] = [];
  const listable: {
    entry: Entry;
    collection: CollectionConfig;
    analysis: MarkdownAnalysis;
    description: string;
  }[] = [];
  const tagCounts = new Map<string, number>();
  const categoryCounts = new Map<string, number>();

  for (const collection of config.collections) {
    const items = visible.filter((e) => e.collection === collection.name);
    const index: Record<string, unknown>[] = [];
    for (const entry of items) {
      const analysis = input.analyses.get(key(entry));
      if (!analysis) {
        warnings.push(`no analysis for ${key(entry)}`);
        continue;
      }
      const fm = entry.frontmatter;
      const html = await renderHtml(entry.body);
      const jsonld = buildJsonLd(entry, analysis, {
        config,
        collection,
        author: fm.author ? authors.get(fm.author) : undefined,
      });
      const description = fm.seo?.description ?? fm.description ?? "";
      const record = {
        id: fm.id,
        collection: collection.name,
        slug: entry.slug,
        path: entry.path,
        url: entry.url,
        title: fm.title,
        status: fm.status,
        publishedAt: fm.publishedAt,
        updatedAt: fm.updatedAt,
        author: fm.author
          ? {
              slug: fm.author,
              name: authors.get(fm.author)?.frontmatter.title ?? fm.author,
              url: authors.get(fm.author)?.url,
            }
          : undefined,
        category: fm.category,
        tags: fm.tags,
        keywords: fm.keywords,
        description: fm.description,
        excerpt: fm.excerpt,
        image: fm.image,
        imageAlt: fm.imageAlt,
        canonical: fm.canonical ?? entry.url,
        language: fm.language ?? config.site.language,
        readingTime: fm.readingTime,
        wordCount: fm.wordCount ?? analysis.wordCount,
        seo: {
          title: fm.seo?.title ?? fm.title,
          description,
          noindex: fm.seo?.noindex ?? false,
          focusKeyword: fm.seo?.focusKeyword,
        },
        social: fm.social,
        aeo: fm.aeo,
        related: fm.related,
        sources: fm.sources,
        custom: customFields(entry, collection),
      };
      index.push(record);
      await write(
        dataRel(config, `content/${collection.name}/${entry.slug}.json`),
        `${JSON.stringify({ ...record, body: entry.body, html, text: analysis.text, toc: tableOfContents(analysis.headings), headings: analysis.headings, jsonld }, null, 2)}\n`,
      );
      if (collection.listable) {
        listable.push({ entry, collection, analysis, description });
        searchDocs.push({
          id: key(entry),
          title: fm.title,
          description,
          text: analysis.text,
          tags: fm.tags.join(" "),
          category: fm.category ?? "",
          collection: collection.name,
          url: entry.url,
          publishedAt: fm.publishedAt,
        });
        for (const t of fm.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
        if (fm.category)
          categoryCounts.set(fm.category, (categoryCounts.get(fm.category) ?? 0) + 1);
      }
    }
    await write(
      dataRel(config, `content/${collection.name}/index.json`),
      `${JSON.stringify({ collection: collection.name, kind: collection.kind, label: collection.label, count: index.length, entries: index }, null, 2)}\n`,
    );
    collectionsOut.push({
      name: collection.name,
      kind: collection.kind,
      label: collection.label,
      description: collection.description,
      urlPattern: collection.urlPattern,
      count: index.length,
      index: `content/${collection.name}/index.json`,
    });
  }

  await write(
    dataRel(config, "site.json"),
    `${JSON.stringify({ generatedAt: nowIso(), site: config.site, collections: collectionsOut, taxonomy: config.taxonomy, outputs: { feeds: config.build.feeds, sitemap: config.build.sitemap, llmsTxt: config.build.llmsTxt, searchIndex: config.build.searchIndex } }, null, 2)}\n`,
  );
  await write(
    dataRel(config, "taxonomy.json"),
    `${JSON.stringify({ categories: [...categoryCounts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count), tags: [...tagCounts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count) }, null, 2)}\n`,
  );

  const sorted = [...listable].sort((a, b) =>
    (b.entry.frontmatter.publishedAt ?? "").localeCompare(a.entry.frontmatter.publishedAt ?? ""),
  );

  if (config.build.feeds) {
    const feedItems = sorted
      .filter((x) => x.collection.kind === "post")
      .slice(0, config.build.feedLimit);
    await write("feeds/rss.xml", rss(config, feedItems));
    await write("feeds/atom.xml", atom(config, feedItems));
    await write("feeds/feed.json", `${JSON.stringify(jsonFeed(config, feedItems), null, 2)}\n`);
  }
  if (config.build.sitemap) await write("sitemap.xml", sitemap(sorted.map((x) => x.entry)));
  if (config.build.llmsTxt) {
    await write("llms.txt", llmsTxt(config, sorted));
    await write("llms-full.txt", llmsFull(config, sorted));
  }
  if (config.build.searchIndex) {
    const ms = new MiniSearch({
      fields: ["title", "description", "text", "tags", "category"],
      storeFields: ["title", "description", "url", "collection", "publishedAt", "category"],
      searchOptions: { boost: { title: 3, tags: 2 }, prefix: true, fuzzy: 0.2 },
    });
    ms.addAll(searchDocs);
    await write(dataRel(config, "search-index.json"), JSON.stringify(ms.toJSON()));
  }
  if (config.build.robots) await write("robots.txt", robots(config));
  if (input.extra) await input.extra(write);

  // Remove files from the previous build that were not regenerated (deleted entries).
  for (const f of previous?.files ?? []) {
    if (!written.has(f.path) && f.path !== manifestRel) {
      await remove(path.join(outDir, f.path));
    }
  }
  const manifest: BuildManifest = {
    generatedAt: nowIso(),
    outDir,
    entries: visible.length,
    files,
    warnings,
  };
  await writeJson(path.join(outDir, manifestRel), manifest);
  return manifest;
}

function customFields(
  entry: Entry,
  collection: CollectionConfig,
): Record<string, unknown> | undefined {
  if (collection.fields.length === 0) return undefined;
  const out: Record<string, unknown> = {};
  for (const f of collection.fields) {
    const v = (entry.frontmatter as Record<string, unknown>)[f.name];
    if (v !== undefined) out[f.name] = v;
  }
  return out;
}

type Item = {
  entry: Entry;
  collection: CollectionConfig;
  analysis: MarkdownAnalysis;
  description: string;
};

function rss(config: CmsConfig, items: Item[]): string {
  const site = config.site;
  const body = items
    .map(({ entry, description }) => {
      const fm = entry.frontmatter;
      return `    <item>
      <title>${escapeXml(fm.title)}</title>
      <link>${escapeXml(entry.url)}</link>
      <guid isPermaLink="true">${escapeXml(entry.url)}</guid>
      ${fm.publishedAt ? `<pubDate>${new Date(fm.publishedAt).toUTCString()}</pubDate>` : ""}
      <description>${escapeXml(description || fm.excerpt || "")}</description>
      ${fm.category ? `<category>${escapeXml(fm.category)}</category>` : ""}
    </item>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(site.name)}</title>
    <link>${escapeXml(site.url)}</link>
    <description>${escapeXml(site.description)}</description>
    <language>${escapeXml(site.language)}</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${escapeXml(rootUrl(config, "feeds/rss.xml"))}" rel="self" type="application/rss+xml" />
${body}
  </channel>
</rss>
`;
}

function atom(config: CmsConfig, items: Item[]): string {
  const site = config.site;
  const updated = items[0]?.entry.frontmatter.updatedAt ?? nowIso();
  const body = items
    .map(({ entry, description }) => {
      const fm = entry.frontmatter;
      return `  <entry>
    <title>${escapeXml(fm.title)}</title>
    <link href="${escapeXml(entry.url)}" />
    <id>${escapeXml(entry.url)}</id>
    <updated>${escapeXml(fm.updatedAt ?? fm.publishedAt ?? updated)}</updated>
    ${fm.publishedAt ? `<published>${escapeXml(fm.publishedAt)}</published>` : ""}
    <summary>${escapeXml(description || fm.excerpt || "")}</summary>
    ${fm.author ? `<author><name>${escapeXml(fm.author)}</name></author>` : ""}
  </entry>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${escapeXml(site.name)}</title>
  <subtitle>${escapeXml(site.description)}</subtitle>
  <link href="${escapeXml(site.url)}" />
  <link href="${escapeXml(rootUrl(config, "feeds/atom.xml"))}" rel="self" />
  <id>${escapeXml(site.url)}/</id>
  <updated>${escapeXml(updated)}</updated>
${body}
</feed>
`;
}

function jsonFeed(config: CmsConfig, items: Item[]): Record<string, unknown> {
  return {
    version: "https://jsonfeed.org/version/1.1",
    title: config.site.name,
    home_page_url: config.site.url,
    feed_url: rootUrl(config, "feeds/feed.json"),
    description: config.site.description,
    language: config.site.language,
    items: items.map(({ entry, description }) => ({
      id: entry.url,
      url: entry.url,
      title: entry.frontmatter.title,
      summary: description || entry.frontmatter.excerpt,
      content_text: entry.body,
      date_published: entry.frontmatter.publishedAt,
      date_modified: entry.frontmatter.updatedAt,
      image: entry.frontmatter.image,
      tags: entry.frontmatter.tags,
      authors: entry.frontmatter.author ? [{ name: entry.frontmatter.author }] : undefined,
    })),
  };
}

function sitemap(entries: Entry[]): string {
  const body = entries
    .filter((e) => !e.frontmatter.seo?.noindex)
    .map(
      (e) => `  <url>
    <loc>${escapeXml(e.url)}</loc>
    ${e.frontmatter.updatedAt ? `<lastmod>${escapeXml(e.frontmatter.updatedAt.slice(0, 10))}</lastmod>` : ""}
  </url>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>
`;
}

function llmsTxt(config: CmsConfig, items: Item[]): string {
  const site = config.site;
  const lines = [`# ${site.name}`, "", `> ${site.description || site.url}`, ""];
  if (site.audience || site.topics.length) {
    lines.push(
      [
        site.audience ? `For ${site.audience}.` : "",
        site.topics.length ? `Topics: ${site.topics.join(", ")}.` : "",
      ]
        .filter(Boolean)
        .join(" "),
      "",
    );
  }
  for (const collection of config.collections) {
    const list = items.filter((x) => x.collection.name === collection.name);
    if (!list.length) continue;
    lines.push(`## ${collection.label ?? collection.name}`, "");
    for (const { entry, description } of list) {
      lines.push(
        `- [${entry.frontmatter.title}](${entry.url})${description ? `: ${description}` : ""}`,
      );
    }
    lines.push("");
  }
  lines.push(
    "## Optional",
    "",
    `- [Full content](${rootUrl(config, "llms-full.txt")}): every entry in Markdown`,
    `- [JSON content API](${dataUrl(config, "site.json")}): machine-readable index`,
    "",
  );
  return lines.join("\n");
}

function llmsFull(config: CmsConfig, items: Item[]): string {
  const parts = [`# ${config.site.name}\n\n> ${config.site.description || config.site.url}\n`];
  for (const { entry } of items) {
    const fm = entry.frontmatter;
    const head = [
      `# ${fm.title}`,
      `URL: ${entry.url}`,
      fm.publishedAt ? `Published: ${fm.publishedAt.slice(0, 10)}` : "",
      fm.updatedAt ? `Updated: ${fm.updatedAt.slice(0, 10)}` : "",
      fm.author ? `Author: ${fm.author}` : "",
      fm.description ? `Summary: ${fm.description}` : "",
    ].filter(Boolean);
    const extras: string[] = [];
    if (fm.aeo?.answer) extras.push(`**Direct answer:** ${fm.aeo.answer}`);
    if (fm.aeo?.keyTakeaways?.length)
      extras.push(`**Key takeaways:**\n${fm.aeo.keyTakeaways.map((t) => `- ${t}`).join("\n")}`);
    if (fm.aeo?.faq?.length)
      extras.push(
        `**FAQ:**\n${fm.aeo.faq.map((f) => `- Q: ${f.question}\n  A: ${f.answer}`).join("\n")}`,
      );
    parts.push(
      `${head.join("\n")}\n\n${extras.length ? `${extras.join("\n\n")}\n\n` : ""}${entry.body.trim()}\n\n---\n`,
    );
  }
  return parts.join("\n");
}

function robots(config: CmsConfig): string {
  const sitemapUrl = `${config.site.url.replace(/\/+$/, "")}/sitemap.xml`;
  return `# Generated by agentcms. Review before deploying to the site root.
User-agent: *
Allow: /

# Answer engines and AI crawlers are allowed so the content can be cited.
User-agent: GPTBot
Allow: /
User-agent: ChatGPT-User
Allow: /
User-agent: ClaudeBot
Allow: /
User-agent: Claude-User
Allow: /
User-agent: PerplexityBot
Allow: /
User-agent: Google-Extended
Allow: /
User-agent: Applebot-Extended
Allow: /

Sitemap: ${sitemapUrl}
`;
}
