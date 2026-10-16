import type { Entry } from "../content/schema.ts";
import type { MarkdownAnalysis } from "../markdown/analyze.ts";

export interface LinkGraph {
  /** key: `${collection}/${slug}` -> number of distinct entries linking to it */
  inbound: Map<string, number>;
  outbound: Map<string, string[]>;
  broken: { from: string; url: string }[];
  /** `${collection}/${slug}` of entries with no inbound links */
  orphans: string[];
}

export function entryKey(e: Pick<Entry, "collection" | "slug">): string {
  return `${e.collection}/${e.slug}`;
}

function normalizePath(p: string): string {
  let out = p.split("#")[0]!.split("?")[0]!;
  out = out.replace(/\/index\.html?$/, "/").replace(/\.html?$/, "");
  if (out.length > 1) out = out.replace(/\/+$/, "");
  return out || "/";
}

export function resolveInternalLink(url: string, siteUrl: string, from: Entry): string | undefined {
  let p: string;
  try {
    if (/^[a-z]+:/i.test(url)) {
      const u = new URL(url);
      if (u.host !== new URL(siteUrl).host) return undefined;
      p = u.pathname;
    } else if (url.startsWith("/")) {
      p = url;
    } else if (url.startsWith("#")) {
      return undefined;
    } else {
      // Relative markdown link such as ./other-post.md or ../pages/about.md
      const base = new URL(`${from.path.replace(/\/[^/]*$/, "/")}`, "https://local.invalid");
      p = new URL(url, base).pathname.replace(/\.mdx?$/, "");
    }
  } catch {
    return undefined;
  }
  return normalizePath(p);
}

export function buildLinkGraph(
  entries: Entry[],
  analyses: Map<string, MarkdownAnalysis>,
  siteUrl: string,
): LinkGraph {
  const byPath = new Map<string, Entry>();
  const bySlug = new Map<string, Entry>();
  for (const e of entries) {
    byPath.set(normalizePath(e.path), e);
    bySlug.set(e.slug, e);
  }
  const inbound = new Map<string, number>();
  const outbound = new Map<string, string[]>();
  const broken: LinkGraph["broken"] = [];
  for (const e of entries) inbound.set(entryKey(e), 0);
  for (const from of entries) {
    const analysis = analyses.get(entryKey(from));
    if (!analysis) continue;
    const targets = new Set<string>();
    for (const link of analysis.links) {
      if (!link.internal) continue;
      const p = resolveInternalLink(link.url, siteUrl, from);
      if (!p) continue;
      const target = byPath.get(p) ?? bySlug.get(p.replace(/^\/+/, "").split("/").pop() ?? "");
      if (!target) {
        broken.push({ from: entryKey(from), url: link.url });
        continue;
      }
      if (entryKey(target) !== entryKey(from)) targets.add(entryKey(target));
    }
    outbound.set(entryKey(from), [...targets]);
    for (const t of targets) inbound.set(t, (inbound.get(t) ?? 0) + 1);
  }
  const orphans = entries
    .filter((e) => e.frontmatter.status === "published" && (inbound.get(entryKey(e)) ?? 0) === 0)
    .map(entryKey);
  return { inbound, outbound, broken, orphans };
}
