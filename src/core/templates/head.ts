import type { CmsConfig } from "../config/schema.ts";
import type { ThemeTokens } from "./theme.ts";

export interface HeadInput {
  title: string;
  description?: string;
  url: string;
  canonical?: string;
  image?: string;
  imageAlt?: string;
  type: "website" | "article" | "profile";
  publishedAt?: string;
  updatedAt?: string;
  section?: string;
  tags?: string[];
  noindex?: boolean;
  language?: string;
  jsonld?: unknown;
  siteName: string;
  twitterSite?: string;
  feeds: boolean;
  siteUrl: string;
}

export function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function abs(siteUrl: string, p: string | undefined): string | undefined {
  if (!p) return undefined;
  if (/^[a-z]+:/i.test(p)) return p;
  return `${siteUrl.replace(/\/+$/, "")}${p.startsWith("/") ? "" : "/"}${p}`;
}

/**
 * The SEO head block the CMS owns. Templates place it with `{{ head | raw }}` so a restyle can
 * never drop the title, description, canonical, social cards, structured data or feed links.
 */
export function renderHead(input: HeadInput, config: CmsConfig, theme: ThemeTokens): string {
  const tags: string[] = [];
  const meta = (attrs: Record<string, string | undefined>) => {
    const parts = Object.entries(attrs)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => `${k}="${escapeAttr(v as string)}"`);
    tags.push(`<meta ${parts.join(" ")}>`);
  };
  const title = input.title.includes(input.siteName)
    ? input.title
    : `${input.title} · ${input.siteName}`;
  tags.push(`<title>${escapeAttr(title)}</title>`);
  if (input.description) meta({ name: "description", content: input.description });
  tags.push(`<link rel="canonical" href="${escapeAttr(input.canonical ?? input.url)}">`);
  if (input.noindex) meta({ name: "robots", content: "noindex, follow" });
  tags.push(`<meta name="generator" content="agentcms">`);
  const image = abs(input.siteUrl, input.image);
  meta({ property: "og:type", content: input.type });
  meta({ property: "og:site_name", content: input.siteName });
  meta({ property: "og:title", content: input.title });
  if (input.description) meta({ property: "og:description", content: input.description });
  meta({ property: "og:url", content: input.canonical ?? input.url });
  if (image) {
    meta({ property: "og:image", content: image });
    if (input.imageAlt) meta({ property: "og:image:alt", content: input.imageAlt });
  }
  if (input.language) meta({ property: "og:locale", content: input.language.replace("-", "_") });
  if (input.type === "article") {
    if (input.publishedAt) meta({ property: "article:published_time", content: input.publishedAt });
    if (input.updatedAt) meta({ property: "article:modified_time", content: input.updatedAt });
    if (input.section) meta({ property: "article:section", content: input.section });
    for (const t of input.tags ?? []) meta({ property: "article:tag", content: t });
  }
  meta({ name: "twitter:card", content: image ? "summary_large_image" : "summary" });
  if (input.twitterSite) meta({ name: "twitter:site", content: input.twitterSite });
  meta({ name: "twitter:title", content: input.title });
  if (input.description) meta({ name: "twitter:description", content: input.description });
  if (image) meta({ name: "twitter:image", content: image });
  if (input.feeds) {
    tags.push(
      `<link rel="alternate" type="application/rss+xml" title="${escapeAttr(input.siteName)}" href="${escapeAttr(abs(input.siteUrl, "/feeds/rss.xml")!)}">`,
    );
    tags.push(
      `<link rel="alternate" type="application/atom+xml" title="${escapeAttr(input.siteName)}" href="${escapeAttr(abs(input.siteUrl, "/feeds/atom.xml")!)}">`,
    );
    tags.push(
      `<link rel="alternate" type="application/feed+json" title="${escapeAttr(input.siteName)}" href="${escapeAttr(abs(input.siteUrl, "/feeds/feed.json")!)}">`,
    );
  }
  if (input.jsonld) {
    tags.push(
      `<script type="application/ld+json">${JSON.stringify(input.jsonld).replace(/</g, "\\u003c")}</script>`,
    );
  }
  tags.push(`<style id="theme-tokens">${themeCss(theme)}</style>`);
  return tags.join("\n  ");
}

/** theme.json tokens as CSS custom properties, with the dark palette behind the system preference. */
export function themeCss(theme: ThemeTokens): string {
  const vars = (colors: Record<string, string>) =>
    Object.entries(colors)
      .map(([k, v]) => `--color-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:${v}`)
      .join(";");
  const base = `:root{${vars(theme.colors)};--font-body:${theme.fonts.body};--font-heading:${theme.fonts.heading};--font-mono:${theme.fonts.mono};--max-width:${theme.layout.maxWidth};--prose-width:${theme.layout.proseWidth};--radius:${theme.layout.radius};color-scheme:${theme.features.darkMode ? "light dark" : "light"}}`;
  const dark = theme.features.darkMode
    ? `@media (prefers-color-scheme:dark){:root{${vars(theme.dark)}}}`
    : "";
  return `${base}${dark}`;
}
