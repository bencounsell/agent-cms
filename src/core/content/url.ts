import type { CollectionConfig } from "../config/schema.ts";
import type { EntryFrontmatter } from "./schema.ts";

export function entryPath(collection: CollectionConfig, fm: EntryFrontmatter): string {
  const date = fm.publishedAt ?? fm.createdAt ?? "";
  const [year = "", month = "", day = ""] = date ? date.slice(0, 10).split("-") : [];
  const p = collection.urlPattern
    .replace("{slug}", fm.slug)
    .replace("{year}", year)
    .replace("{month}", month)
    .replace("{day}", day)
    .replace("{category}", (fm.category ?? "uncategorized").toLowerCase().replace(/\s+/g, "-"))
    .replace("{collection}", collection.name)
    .replace(/\/{2,}/g, "/");
  return p.startsWith("/") ? p : `/${p}`;
}

export function absoluteUrl(siteUrl: string, p: string): string {
  return `${siteUrl.replace(/\/+$/, "")}${p}`;
}
