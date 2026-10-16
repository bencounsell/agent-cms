import type { AiResolution } from "../ai/types.ts";
import type { AuditResult } from "../analysis/audit.ts";
import type { LinkGraph } from "../analysis/links.ts";
import type { CmsConfig } from "../config/schema.ts";
import type { Entry } from "../content/schema.ts";
import type { ValidationIssue } from "../content/store.ts";
import type { CompetitorRecord } from "../research/types.ts";
import { daysSince, nowIso } from "../util/dates.ts";
import { pluralize } from "../util/text.ts";
import type { Briefing, EntryRef, NextAction } from "./types.ts";

export interface BriefingInput {
  config: CmsConfig;
  entries: Entry[];
  audits: Map<string, AuditResult>;
  linkGraph: LinkGraph;
  validation: ValidationIssue[];
  competitors: CompetitorRecord[];
  ai: AiResolution;
  now?: Date;
}

const ref = (e: Entry): EntryRef => ({
  collection: e.collection,
  slug: e.slug,
  title: e.frontmatter.title,
  url: e.url,
  status: e.frontmatter.status,
});

export function buildBriefing(input: BriefingInput): Briefing {
  const { config, entries, audits, linkGraph } = input;
  const now = input.now ?? new Date();
  const key = (e: Entry) => `${e.collection}/${e.slug}`;
  const articleCollections = new Set(
    config.collections.filter((c) => c.kind !== "author").map((c) => c.name),
  );
  const articles = entries.filter((e) => articleCollections.has(e.collection));

  const byCollection = config.collections.map((c) => {
    const items = entries.filter((e) => e.collection === c.name);
    const byStatus: Record<string, number> = {};
    for (const e of items)
      byStatus[e.frontmatter.status] = (byStatus[e.frontmatter.status] ?? 0) + 1;
    return { name: c.name, kind: c.kind, total: items.length, byStatus };
  });

  const drafts = articles
    .filter((e) => e.frontmatter.status === "draft")
    .map((e) => ({
      ...ref(e),
      ageDays: daysSince(e.frontmatter.updatedAt ?? e.frontmatter.createdAt, now) ?? 0,
      auditScore: audits.get(key(e))?.scores.overall,
    }))
    .sort((a, b) => b.ageDays - a.ageDays);
  const inReview = articles
    .filter((e) => e.frontmatter.status === "review" || (e.frontmatter.review?.length ?? 0) > 0)
    .map((e) => ({ ...ref(e), review: e.frontmatter.review ?? [] }));
  const stale = articles
    .filter((e) => e.frontmatter.status === "published")
    .map((e) => ({
      ...ref(e),
      ageDays: daysSince(e.frontmatter.updatedAt ?? e.frontmatter.publishedAt, now) ?? 0,
    }))
    .filter((e) => e.ageDays > config.seo.staleAfterDays)
    .sort((a, b) => b.ageDays - a.ageDays);
  const weakMetadata = articles
    .map((e) => {
      const fm = e.frontmatter;
      const missing: string[] = [];
      if (!fm.description) missing.push("description");
      if (!fm.category) missing.push("category");
      if (fm.tags.length === 0) missing.push("tags");
      if (fm.keywords.length === 0) missing.push("keywords");
      if (!fm.image) missing.push("image");
      if (!fm.aeo?.answer) missing.push("aeo.answer");
      if (!fm.aeo?.faq?.length) missing.push("aeo.faq");
      return { ...ref(e), missing };
    })
    .filter((e) => e.missing.length > 0 && e.status !== "archived");
  const lowScores = articles
    .filter((e) => e.frontmatter.status !== "archived")
    .map((e) => ({ e, a: audits.get(key(e)) }))
    .filter(
      (x): x is { e: Entry; a: AuditResult } =>
        Boolean(x.a) && x.a!.scores.overall < config.seo.minAuditScoreToPublish,
    )
    .map(({ e, a }) => ({
      ...ref(e),
      overall: a.scores.overall,
      topIssue: a.failed[0]?.message ?? "",
    }))
    .sort((a, b) => a.overall - b.overall);
  const orphans = linkGraph.orphans
    .map((k) => entries.find((e) => key(e) === k))
    .filter((e): e is Entry => Boolean(e))
    .map(ref);
  const validationErrors = input.validation.filter((v) => v.severity === "error");
  const validationWarnings = input.validation.filter((v) => v.severity === "warning");

  const lastRefresh = input.competitors
    .map((c) => c.latest?.fetchedAt)
    .filter(Boolean)
    .sort()
    .pop();
  const refreshDue =
    input.competitors.length > 0 &&
    (lastRefresh === undefined ||
      (daysSince(lastRefresh, now) ?? 0) >= config.research.refreshAfterDays);
  const newPages = input.competitors
    .map((c) => {
      const last = c.history[c.history.length - 1];
      return {
        host: c.host,
        count: last?.newPages.length ?? 0,
        titles: (last?.newPages ?? []).slice(0, 3).map((p) => p.title ?? p.url),
      };
    })
    .filter((c) => c.count > 0);

  const nextActions: NextAction[] = [];
  if (validationErrors.length) {
    nextActions.push({
      priority: 1,
      action: `Fix ${pluralize(validationErrors.length, "invalid content file")}`,
      tool: "validate_content",
      args: {},
      reason: validationErrors[0]!.message,
    });
  }
  for (const e of weakMetadata
    .filter((w) => w.missing.includes("description") || w.missing.includes("keywords"))
    .slice(0, 3)) {
    nextActions.push({
      priority: 1,
      action: `Generate metadata for "${e.title}"`,
      tool: "enrich_metadata",
      args: { collection: e.collection, slug: e.slug },
      reason: `missing ${e.missing.join(", ")}`,
    });
  }
  for (const d of drafts.slice(0, 2)) {
    nextActions.push({
      priority: 2,
      action: `Finish draft "${d.title}"`,
      tool: "audit_content",
      args: { collection: d.collection, slug: d.slug },
      reason: `draft for ${d.ageDays} days${d.auditScore !== undefined ? `, audit score ${d.auditScore}` : ""}`,
    });
  }
  for (const r of inReview.slice(0, 2)) {
    nextActions.push({
      priority: 2,
      action: `Review "${r.title}"`,
      tool: "get_content",
      args: { collection: r.collection, slug: r.slug },
      reason: r.review.length ? `fields to confirm: ${r.review.join(", ")}` : "awaiting review",
    });
  }
  for (const s of stale.slice(0, 2)) {
    nextActions.push({
      priority: 2,
      action: `Refresh "${s.title}"`,
      tool: "improve_content",
      args: { collection: s.collection, slug: s.slug },
      reason: `not updated for ${s.ageDays} days`,
    });
  }
  for (const l of lowScores.slice(0, 2)) {
    nextActions.push({
      priority: 2,
      action: `Improve "${l.title}" (score ${l.overall})`,
      tool: "improve_content",
      args: { collection: l.collection, slug: l.slug },
      reason: l.topIssue,
    });
  }
  if (orphans.length) {
    nextActions.push({
      priority: 3,
      action: `Link to ${pluralize(orphans.length, "orphan entry", "orphan entries")}`,
      tool: "improve_content",
      args: { collection: orphans[0]!.collection, slug: orphans[0]!.slug },
      reason: "no other entry links to them",
    });
  }
  if (input.competitors.length === 0) {
    nextActions.push({
      priority: 3,
      action: "Add competitors to research",
      tool: "add_competitor",
      args: { url: "https://competitor.example" },
      reason: "no competitor sites are tracked yet, so content-gap analysis is empty",
    });
  } else if (refreshDue) {
    nextActions.push({
      priority: 3,
      action: "Refresh competitor research",
      tool: "research_competitors",
      args: {},
      reason: lastRefresh
        ? `last refresh ${daysSince(lastRefresh, now)} days ago`
        : "never refreshed",
    });
  }
  if (newPages.length) {
    nextActions.push({
      priority: 2,
      action: "Review new competitor content",
      tool: "compare_competitors",
      args: {},
      reason: newPages.map((n) => `${n.host}: ${n.count} new`).join(", "),
    });
  }
  if (articles.length === 0) {
    nextActions.push({
      priority: 1,
      action: "Create the first post",
      tool: "suggest_content",
      args: {},
      reason: "the site has no content yet",
    });
  } else if (nextActions.length < 3) {
    nextActions.push({
      priority: 3,
      action: "Get content ideas",
      tool: "suggest_content",
      args: {},
      reason: "keep the pipeline full",
    });
  }
  nextActions.sort((a, b) => a.priority - b.priority);

  const published = byCollection.reduce((n, c) => n + (c.byStatus.published ?? 0), 0);
  const headlineParts = [
    `${pluralize(entries.length, "entry", "entries")} (${published} published, ${drafts.length} drafts)`,
    stale.length ? `${stale.length} stale` : "",
    weakMetadata.length ? `${weakMetadata.length} with thin metadata` : "",
    lowScores.length ? `${lowScores.length} below the publish threshold` : "",
    newPages.length ? `${newPages.reduce((n, x) => n + x.count, 0)} new competitor pages` : "",
  ].filter(Boolean);

  return {
    generatedAt: nowIso(),
    headline:
      `${config.site.name}: ${headlineParts.join(", ")}. ${nextActions[0] ? `Start with: ${nextActions[0].action}.` : ""}`.trim(),
    site: { name: config.site.name, url: config.site.url },
    counts: { total: entries.length, byCollection },
    drafts: drafts.slice(0, 10),
    inReview: inReview.slice(0, 10),
    stale: stale.slice(0, 10),
    weakMetadata: weakMetadata.slice(0, 10),
    lowScores: lowScores.slice(0, 10),
    orphans: orphans.slice(0, 10),
    brokenLinks: linkGraph.broken.slice(0, 10),
    validation: {
      errors: validationErrors.length,
      warnings: validationWarnings.length,
      sample: input.validation.slice(0, 5).map((v) => `${v.file}: ${v.message}`),
    },
    research: { competitors: input.competitors.length, lastRefresh, refreshDue, newPages },
    ai:
      input.ai.mode === "provider"
        ? { mode: "provider", provider: `${input.ai.provider.name} (${input.ai.provider.model})` }
        : { mode: input.ai.mode, reason: input.ai.reason },
    nextActions: nextActions.slice(0, 8),
  };
}
