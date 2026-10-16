import type { Entry } from "../content/schema.ts";
import { entryKey } from "./links.ts";

export interface DuplicateReport {
  titles: Map<string, string[]>;
  descriptions: Map<string, string[]>;
}

function norm(s: string | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function findDuplicates(entries: Entry[]): DuplicateReport {
  const titles = new Map<string, string[]>();
  const descriptions = new Map<string, string[]>();
  for (const e of entries) {
    const t = norm(e.frontmatter.seo?.title ?? e.frontmatter.title);
    if (t) titles.set(t, [...(titles.get(t) ?? []), entryKey(e)]);
    const d = norm(e.frontmatter.seo?.description ?? e.frontmatter.description);
    if (d) descriptions.set(d, [...(descriptions.get(d) ?? []), entryKey(e)]);
  }
  for (const [k, v] of titles) if (v.length < 2) titles.delete(k);
  for (const [k, v] of descriptions) if (v.length < 2) descriptions.delete(k);
  return { titles, descriptions };
}
