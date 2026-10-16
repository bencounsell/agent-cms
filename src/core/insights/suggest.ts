import { z } from "zod";
import type { AiResolution } from "../ai/types.ts";
import type { AuditResult } from "../analysis/audit.ts";
import { containsPhrase, keywordOverlap } from "../analysis/keywords.ts";
import type { LinkGraph } from "../analysis/links.ts";
import type { CmsConfig } from "../config/schema.ts";
import type { Entry } from "../content/schema.ts";
import type { MarkdownAnalysis } from "../markdown/analyze.ts";
import type { ComparisonReport, CompetitorRecord } from "../research/types.ts";
import { daysSince } from "../util/dates.ts";
import { log } from "../util/log.ts";
import { slugify, titleCase, uniq } from "../util/text.ts";
import type { Suggestion } from "./types.ts";

export interface SuggestInput {
  config: CmsConfig;
  entries: Entry[];
  analyses: Map<string, MarkdownAnalysis>;
  audits: Map<string, AuditResult>;
  linkGraph: LinkGraph;
  competitors: CompetitorRecord[];
  comparison?: ComparisonReport;
  ai: AiResolution;
  limit?: number;
  /** Narrow suggestions to a theme, e.g. "pricing" or "onboarding". */
  focus?: string;
  now?: Date;
}

const key = (e: Entry) => `${e.collection}/${e.slug}`;

export function suggestDeterministic(input: SuggestInput): Suggestion[] {
  const { config, entries, analyses, audits, linkGraph } = input;
  const now = input.now ?? new Date();
  const out: Suggestion[] = [];
  const articles = entries.filter(
    (e) =>
      config.collections.find((c) => c.name === e.collection)?.kind !== "author" &&
      e.frontmatter.status !== "archived",
  );
  const postCollection =
    config.collections.find((c) => c.kind === "post")?.name ?? config.collections[0]!.name;

  // 1. Topic gaps versus competitors.
  for (const gap of input.comparison?.gaps.slice(0, 10) ?? []) {
    out.push({
      id: `new:${slugify(gap.topic)}`,
      type: "new",
      title: titleCase(gap.topic),
      rationale: `${gap.competitorPages.length} competitor page(s) cover "${gap.topic}"; the site has nothing on it.`,
      evidence: gap.competitorPages.map((p) => `${p.host}: ${p.title ?? p.url}`),
      targetKeywords: [gap.topic],
      effort: "large",
      score: 50 + gap.score * 4,
      action: {
        priority: 1,
        action: `Draft "${titleCase(gap.topic)}"`,
        tool: "create_content",
        args: { collection: postCollection, title: titleCase(gap.topic) },
        reason: "competitor topic gap",
      },
    });
  }

  // 2. Questions competitors answer in headings that we do not.
  const ourText = articles
    .map(
      (e) =>
        `${e.frontmatter.title} ${
          analyses
            .get(key(e))
            ?.headings.map((h) => h.text)
            .join(" ") ?? ""
        } ${(e.frontmatter.aeo?.questions ?? []).join(" ")}`,
    )
    .join("\n");
  const seenQ = new Set<string>();
  for (const rec of input.competitors) {
    for (const page of rec.latest?.pages ?? []) {
      for (const h of [...page.h2, ...page.h3]) {
        if (!/\?$/.test(h) || h.length < 15 || h.length > 120) continue;
        const k = h.toLowerCase();
        if (seenQ.has(k)) continue;
        const core = h.replace(/\?$/, "").split(" ").slice(-3).join(" ");
        if (containsPhrase(ourText, core)) continue;
        seenQ.add(k);
        out.push({
          id: `new:q:${slugify(h)}`,
          type: "new",
          title: h,
          rationale: `${rec.host} answers this question (on "${page.title ?? page.url}"); a dedicated answer-first post can win the snippet.`,
          evidence: [page.url],
          targetKeywords: [h.replace(/\?$/, "").toLowerCase()],
          effort: "medium",
          score: 45,
          action: {
            priority: 2,
            action: `Draft "${h}"`,
            tool: "create_content",
            args: { collection: postCollection, title: h },
            reason: "competitor answers it, we do not",
          },
        });
        if (seenQ.size >= 10) break;
      }
    }
  }

  // 3. Thin clusters: categories or tags with a single entry deserve a series.
  const tagCounts = new Map<string, Entry[]>();
  for (const e of articles) {
    const strongTags = e.frontmatter.tags.filter(
      (t) => t.includes("-") || e.frontmatter.keywords.slice(0, 3).some((k) => slugify(k) === t),
    );
    for (const t of [...strongTags, ...(e.frontmatter.category ? [e.frontmatter.category] : [])])
      tagCounts.set(t, [...(tagCounts.get(t) ?? []), e]);
  }
  let seriesCount = 0;
  for (const [tag, items] of tagCounts) {
    if (items.length !== 1 || articles.length < 3 || seriesCount >= 3) continue;
    seriesCount++;
    const e = items[0]!;
    out.push({
      id: `series:${slugify(tag)}`,
      type: "series",
      title: `Build out the "${tag}" topic`,
      rationale: `Only "${e.frontmatter.title}" covers ${tag}. Topic clusters of 3+ linked pieces rank better than lone posts.`,
      evidence: [e.url],
      targetKeywords: [tag],
      relatedEntries: [key(e)],
      effort: "large",
      score: 30,
    });
  }

  // 4. Refresh stale content, prioritising entries other pages link to.
  for (const e of articles) {
    if (e.frontmatter.status !== "published") continue;
    const age = daysSince(e.frontmatter.updatedAt ?? e.frontmatter.publishedAt, now) ?? 0;
    if (age <= config.seo.staleAfterDays) continue;
    const inbound = linkGraph.inbound.get(key(e)) ?? 0;
    out.push({
      id: `refresh:${key(e)}`,
      type: "refresh",
      title: `Refresh "${e.frontmatter.title}"`,
      rationale: `Last updated ${age} days ago${inbound ? ` and ${inbound} entries link to it` : ""}. Update facts, examples and the date to regain freshness signals.`,
      evidence: [e.url],
      targetKeywords: e.frontmatter.keywords.slice(0, 3),
      relatedEntries: [key(e)],
      effort: "small",
      score: 35 + Math.min(20, inbound * 5) + Math.min(10, (age - config.seo.staleAfterDays) / 30),
      action: {
        priority: 2,
        action: `Refresh "${e.frontmatter.title}"`,
        tool: "improve_content",
        args: { collection: e.collection, slug: e.slug },
        reason: `stale for ${age} days`,
      },
    });
  }

  // 5. Expand short entries that already attract links or sit in a strong cluster.
  for (const e of articles) {
    const a = analyses.get(key(e));
    if (!a || a.wordCount >= config.seo.targetWordCount * 0.6 || a.wordCount < 50) continue;
    const inbound = linkGraph.inbound.get(key(e)) ?? 0;
    out.push({
      id: `expand:${key(e)}`,
      type: "expand",
      title: `Expand "${e.frontmatter.title}"`,
      rationale: `${a.wordCount} words against a target of ~${config.seo.targetWordCount}${inbound ? `; ${inbound} entries already link to it` : ""}.`,
      evidence: [e.url],
      targetKeywords: e.frontmatter.keywords.slice(0, 3),
      relatedEntries: [key(e)],
      effort: "medium",
      score: 25 + Math.min(20, inbound * 5),
      action: {
        priority: 2,
        action: `Expand "${e.frontmatter.title}"`,
        tool: "improve_content",
        args: { collection: e.collection, slug: e.slug },
        reason: "thin content",
      },
    });
  }

  // 6. Internal link opportunities: topically close pairs that do not link.
  const pairs = new Set<string>();
  for (const a of articles) {
    for (const b of articles) {
      if (a === b || a.collection !== b.collection) continue;
      const pk = [key(a), key(b)].sort().join("|");
      if (pairs.has(pk)) continue;
      const overlap = keywordOverlap(
        [...a.frontmatter.keywords, ...a.frontmatter.tags],
        [...b.frontmatter.keywords, ...b.frontmatter.tags],
      );
      if (overlap < 0.4) continue;
      const linked =
        (linkGraph.outbound.get(key(a)) ?? []).includes(key(b)) ||
        (linkGraph.outbound.get(key(b)) ?? []).includes(key(a));
      if (linked) continue;
      pairs.add(pk);
      out.push({
        id: `link:${pk}`,
        type: "link",
        title: `Link "${a.frontmatter.title}" and "${b.frontmatter.title}"`,
        rationale: `They share ${Math.round(overlap * 100)}% of their keywords but do not link to each other.`,
        evidence: [a.url, b.url],
        targetKeywords: a.frontmatter.keywords
          .filter((k) => b.frontmatter.keywords.includes(k))
          .slice(0, 3),
        relatedEntries: [key(a), key(b)],
        effort: "small",
        score: 20 + overlap * 10,
      });
    }
  }

  // 7. Structure: posts without FAQ or answer-first lead.
  for (const e of articles) {
    const audit = audits.get(key(e));
    if (!audit) continue;
    const missing = audit.failed.filter((c) => c.id === "aeo.faq" || c.id === "aeo.answer-first");
    if (missing.length === 0 || e.frontmatter.status !== "published") continue;
    out.push({
      id: `structure:${key(e)}`,
      type: "structure",
      title: `Make "${e.frontmatter.title}" answer-engine ready`,
      rationale: missing.map((m) => m.message).join(" "),
      evidence: [e.url],
      targetKeywords: e.frontmatter.keywords.slice(0, 2),
      relatedEntries: [key(e)],
      effort: "small",
      score: 22,
      action: {
        priority: 3,
        action: `Add FAQ/answer to "${e.frontmatter.title}"`,
        tool: "improve_content",
        args: { collection: e.collection, slug: e.slug },
        reason: "AEO structure missing",
      },
    });
  }

  let result = out;
  if (input.focus) {
    const f = input.focus.toLowerCase();
    result = result.filter((s) =>
      `${s.title} ${s.rationale} ${s.targetKeywords.join(" ")}`.toLowerCase().includes(f),
    );
  }
  return result.sort((a, b) => b.score - a.score).slice(0, input.limit ?? 15);
}

const AiSuggestionsSchema = z.object({
  suggestions: z.array(
    z.object({
      id: z.string().describe("The id of the suggestion being refined, copied exactly"),
      title: z.string().describe("A compelling, specific working title"),
      outline: z
        .array(z.string())
        .describe("4-8 H2 headings in order, question-form where natural"),
      targetKeywords: z.array(z.string()).describe("2-4 search phrases"),
      rationale: z.string().describe("One or two sentences on why this will perform"),
    }),
  ),
  additional: z
    .array(
      z.object({
        title: z.string(),
        rationale: z.string(),
        outline: z.array(z.string()),
        targetKeywords: z.array(z.string()),
      }),
    )
    .describe(
      "Up to 3 further ideas the deterministic analysis missed, grounded in the site description and existing content",
    ),
});

/** Optionally let a model sharpen titles and add outlines. Falls back silently. */
export async function refineSuggestionsWithAi(
  input: SuggestInput,
  suggestions: Suggestion[],
): Promise<Suggestion[]> {
  if (input.ai.mode !== "provider" || suggestions.length === 0) return suggestions;
  const site = input.config.site;
  const existing = input.entries
    .slice(0, 80)
    .map((e) => `- ${e.frontmatter.title} [${e.frontmatter.status}]`)
    .join("\n");
  const system = `You are the content strategist for ${site.name} (${site.url}). ${site.description} ${site.audience ? `Audience: ${site.audience}.` : ""} ${site.topics.length ? `Topics: ${site.topics.join(", ")}.` : ""} Be specific and grounded; never propose content that already exists.`;
  const prompt = `Existing content:\n${existing || "(none)"}\n\nCandidate suggestions (JSON):\n${JSON.stringify(
    suggestions.slice(0, 8).map((s) => ({
      id: s.id,
      type: s.type,
      title: s.title,
      rationale: s.rationale,
      targetKeywords: s.targetKeywords,
    })),
    null,
    1,
  )}\n\nRefine the candidates of type "new" and "series" with strong titles and outlines, keep others as they are, and add up to three new ideas.`;
  try {
    const refined = await input.ai.provider.generateStructured({
      system,
      prompt,
      schema: AiSuggestionsSchema,
      schemaName: "content_suggestions",
      maxTokens: 6000,
    });
    const byId = new Map(refined.suggestions.map((r) => [r.id, r]));
    const merged = suggestions.map((s) => {
      const r = byId.get(s.id);
      if (!r) return s;
      return {
        ...s,
        title: r.title || s.title,
        outline: r.outline,
        targetKeywords: uniq([...r.targetKeywords, ...s.targetKeywords]).slice(0, 5),
        rationale: r.rationale || s.rationale,
        action: s.action
          ? {
              ...s.action,
              action: `Draft "${r.title || s.title}"`,
              args: { ...s.action.args, title: r.title || s.title },
            }
          : s.action,
      };
    });
    const postCollection =
      input.config.collections.find((c) => c.kind === "post")?.name ??
      input.config.collections[0]!.name;
    for (const a of refined.additional.slice(0, 3)) {
      merged.push({
        id: `new:ai:${slugify(a.title)}`,
        type: "new",
        title: a.title,
        rationale: a.rationale,
        evidence: ["model suggestion"],
        targetKeywords: a.targetKeywords,
        outline: a.outline,
        effort: "large",
        score: 40,
        action: {
          priority: 2,
          action: `Draft "${a.title}"`,
          tool: "create_content",
          args: { collection: postCollection, title: a.title },
          reason: "model suggestion",
        },
      });
    }
    return merged;
  } catch (err) {
    log.warn("AI suggestion refinement failed:", err);
    return suggestions;
  }
}
