import type { CmsConfig, CollectionConfig } from "../config/schema.ts";
import type { Entry } from "../content/schema.ts";
import type { MarkdownAnalysis } from "../markdown/analyze.ts";

export type JsonLd = Record<string, unknown>;

function mainType(kind: CollectionConfig["kind"]): string {
  switch (kind) {
    case "post":
      return "BlogPosting";
    case "doc":
      return "TechArticle";
    case "page":
      return "WebPage";
    case "author":
      return "Person";
    default:
      return "Article";
  }
}

function absolute(siteUrl: string, p: string | undefined): string | undefined {
  if (!p) return undefined;
  if (/^[a-z]+:/i.test(p)) return p;
  return `${siteUrl.replace(/\/+$/, "")}${p.startsWith("/") ? "" : "/"}${p}`;
}

function compact(obj: JsonLd): JsonLd {
  const out: JsonLd = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v;
  }
  return out;
}

export interface JsonLdContext {
  config: CmsConfig;
  collection: CollectionConfig;
  author?: Entry;
}

export function buildJsonLd(entry: Entry, analysis: MarkdownAnalysis, ctx: JsonLdContext): JsonLd {
  const { config, collection } = ctx;
  const fm = entry.frontmatter;
  const site = config.site;
  const siteUrl = site.url;
  const type = mainType(collection.kind);
  const orgName = site.organization?.name ?? site.name;
  const publisher = compact({
    "@type": "Organization",
    name: orgName,
    url: site.organization?.url ?? siteUrl,
    logo: site.organization?.logo
      ? { "@type": "ImageObject", url: absolute(siteUrl, site.organization.logo) }
      : undefined,
  });
  const authorName = ctx.author?.frontmatter.title ?? fm.author;
  const author = authorName
    ? compact({
        "@type": "Person",
        name: authorName,
        url: ctx.author?.url,
        description: ctx.author?.frontmatter.description,
      })
    : undefined;

  const graph: JsonLd[] = [];

  if (type === "Person") {
    graph.push(
      compact({
        "@type": "Person",
        "@id": entry.url,
        name: fm.title,
        description: fm.description,
        url: entry.url,
        image: absolute(siteUrl, fm.image),
        sameAs: site.social.profiles,
        worksFor: publisher,
      }),
    );
  } else {
    graph.push(
      compact({
        "@type": type,
        "@id": entry.url,
        headline: fm.seo?.title ?? fm.title,
        name: fm.title,
        description: fm.seo?.description ?? fm.description,
        url: entry.url,
        mainEntityOfPage: { "@type": "WebPage", "@id": entry.url },
        datePublished: fm.publishedAt,
        dateModified: fm.updatedAt ?? fm.publishedAt,
        author,
        publisher,
        image: absolute(siteUrl, fm.image),
        keywords: fm.keywords.length ? fm.keywords.join(", ") : undefined,
        articleSection: fm.category,
        wordCount: type === "WebPage" ? undefined : analysis.wordCount,
        inLanguage: fm.language ?? site.language,
        timeRequired: fm.readingTime ? `PT${fm.readingTime}M` : undefined,
        isPartOf: { "@type": "WebSite", name: site.name, url: siteUrl },
        abstract: fm.aeo?.answer,
        citation: fm.sources?.length ? fm.sources : undefined,
      }),
    );
  }

  const faq = fm.aeo?.faq ?? [];
  if (faq.length > 0) {
    graph.push({
      "@type": "FAQPage",
      "@id": `${entry.url}#faq`,
      mainEntity: faq.map((item) => ({
        "@type": "Question",
        name: item.question,
        acceptedAnswer: { "@type": "Answer", text: item.answer },
      })),
    });
  }

  const crumbs: JsonLd[] = [{ "@type": "ListItem", position: 1, name: "Home", item: siteUrl }];
  const collectionBase = collection.urlPattern.split("{")[0]!.replace(/\/+$/, "");
  if (collectionBase && collectionBase !== "") {
    crumbs.push({
      "@type": "ListItem",
      position: 2,
      name: collection.label ?? collection.name,
      item: absolute(siteUrl, collectionBase),
    });
  }
  crumbs.push({
    "@type": "ListItem",
    position: crumbs.length + 1,
    name: fm.title,
    item: entry.url,
  });
  graph.push({
    "@type": "BreadcrumbList",
    "@id": `${entry.url}#breadcrumb`,
    itemListElement: crumbs,
  });

  if (fm.schema && Object.keys(fm.schema).length > 0) {
    graph[0] = { ...graph[0], ...fm.schema };
  }

  return { "@context": "https://schema.org", "@graph": graph };
}
