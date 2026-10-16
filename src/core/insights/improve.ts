import type { AuditResult } from "../analysis/audit.ts";
import { containsPhrase, keywordOverlap } from "../analysis/keywords.ts";
import type { LinkGraph } from "../analysis/links.ts";
import type { CmsConfig } from "../config/schema.ts";
import type { Entry } from "../content/schema.ts";
import type { MarkdownAnalysis } from "../markdown/analyze.ts";
import type { CompetitorRecord } from "../research/types.ts";
import { uniq } from "../util/text.ts";
import type { ImprovementPlan, ImprovementStep } from "./types.ts";

export interface ImproveInput {
  config: CmsConfig;
  entry: Entry;
  analysis: MarkdownAnalysis;
  audit: AuditResult;
  entries: Entry[];
  linkGraph: LinkGraph;
  competitors: CompetitorRecord[];
}

const key = (e: Entry) => `${e.collection}/${e.slug}`;

export function buildImprovementPlan(input: ImproveInput): ImprovementPlan {
  const { entry, analysis, audit, config } = input;
  const fm = entry.frontmatter;
  const steps: ImprovementStep[] = [];
  const sevPriority = { error: 1, warning: 2, info: 3 } as const;
  for (const c of audit.failed) {
    steps.push({
      priority: sevPriority[c.severity],
      area: c.area,
      action: c.fix ?? c.message,
      detail: c.message,
      evidence: c.evidence,
    });
  }

  // Internal link candidates: topically close entries we do not link to yet.
  const outbound = new Set(input.linkGraph.outbound.get(key(entry)) ?? []);
  const mine = uniq([...fm.keywords, ...fm.tags, ...(fm.category ? [fm.category] : [])]);
  const linkCandidates = input.entries
    .filter(
      (e) => key(e) !== key(entry) && e.frontmatter.status === "published" && !outbound.has(key(e)),
    )
    .map((e) => {
      const theirs = uniq([
        ...e.frontmatter.keywords,
        ...e.frontmatter.tags,
        ...(e.frontmatter.category ? [e.frontmatter.category] : []),
      ]);
      let score = keywordOverlap(mine, theirs);
      if (containsPhrase(analysis.text, e.frontmatter.title)) score += 0.5;
      const shared = mine.filter((k) =>
        theirs.map((t) => t.toLowerCase()).includes(k.toLowerCase()),
      );
      return { e, score, shared };
    })
    .filter((x) => x.score >= 0.25)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ e, shared }) => ({
      collection: e.collection,
      slug: e.slug,
      title: e.frontmatter.title,
      url: e.url,
      reason: shared.length
        ? `shares ${shared.slice(0, 3).join(", ")}`
        : "title mentioned in the text",
    }));
  if (linkCandidates.length && audit.stats.internalLinks < config.seo.minInternalLinks) {
    steps.push({
      priority: 2,
      area: "links",
      action: `Add internal links to: ${linkCandidates.map((c) => `"${c.title}" (${c.url})`).join(", ")}`,
      detail: "Internal links pass authority and help crawlers understand the topic cluster.",
    });
  }

  // FAQ and question candidates from the content itself and from competitors on the same topic.
  const questionCandidates = uniq([
    ...analysis.headings
      .filter((h) => h.isQuestion)
      .map((h) => (h.text.endsWith("?") ? h.text : `${h.text}?`)),
    ...(fm.aeo?.questions ?? []),
  ]);
  const competitorBenchmarks: ImprovementPlan["competitorBenchmarks"] = [];
  const focus = audit.focusKeyword;
  for (const rec of input.competitors) {
    for (const page of rec.latest?.pages ?? []) {
      const overlap = keywordOverlap(
        [...fm.keywords, ...(focus ? [focus] : [])],
        [...page.keywords, page.title ?? ""],
      );
      const titleHit = focus
        ? containsPhrase(`${page.title ?? ""} ${page.h1 ?? ""}`, focus)
        : false;
      if (overlap < 0.2 && !titleHit) continue;
      competitorBenchmarks.push({
        host: rec.host,
        url: page.url,
        title: page.title,
        wordCount: page.wordCount,
        hasFaq: page.hasFaq,
      });
      for (const h of [...page.h2, ...page.h3])
        if (/\?$/.test(h) && h.length < 120) questionCandidates.push(h);
    }
  }
  const faqCandidates = uniq(questionCandidates)
    .filter((q) => !(fm.aeo?.faq ?? []).some((f) => f.question.toLowerCase() === q.toLowerCase()))
    .slice(0, 8);
  if (competitorBenchmarks.length) {
    const longer = competitorBenchmarks.filter((b) => b.wordCount > analysis.wordCount * 1.3);
    if (longer.length) {
      steps.push({
        priority: 2,
        area: "seo",
        action: `Competing pages are longer (${longer.map((b) => `${b.host}: ${b.wordCount} words`).join(", ")}); cover the sub-topics they cover`,
        detail: "Depth on the same intent is the most reliable ranking lever.",
        evidence: longer.map((b) => b.url),
      });
    }
  }
  if (faqCandidates.length && !fm.aeo?.faq?.length) {
    steps.push({
      priority: 2,
      area: "aeo",
      action: `Add an FAQ answering: ${faqCandidates.slice(0, 4).join(" | ")}`,
      detail: "Store the pairs in aeo.faq so FAQPage structured data is emitted.",
    });
  }
  if (!fm.aeo?.answer) {
    steps.push({
      priority: 1,
      area: "aeo",
      action: `Write a 40–70 word direct answer to "${(fm.aeo?.questions ?? questionCandidates)[0] ?? fm.title}" as the opening paragraph and set aeo.answer`,
      detail: "Answer engines quote the first self-contained answer they find.",
    });
  }
  const thinSections = analysis.sections.filter(
    (s) => s.heading && s.heading.depth === 2 && s.wordCount < 60,
  );
  if (thinSections.length) {
    steps.push({
      priority: 3,
      area: "seo",
      action: `Expand thin sections: ${thinSections.map((s) => `"${s.heading!.text}" (${s.wordCount} words)`).join(", ")}`,
      detail: "Each H2 should fully answer its heading.",
    });
  }
  steps.sort((a, b) => a.priority - b.priority);

  const summary = `${fm.title}: overall ${audit.scores.overall}/100. ${steps.length} improvement step(s); top: ${steps[0]?.action ?? "none"}.`;
  return {
    collection: entry.collection,
    slug: entry.slug,
    title: fm.title,
    url: entry.url,
    scores: { ...audit.scores },
    publishable: audit.publishable,
    steps,
    linkCandidates: linkCandidates.map(({ collection, slug, title, url, reason }) => ({
      collection,
      slug,
      title,
      url,
      reason,
    })),
    faqCandidates,
    questionCandidates: uniq(questionCandidates).slice(0, 8),
    competitorBenchmarks: competitorBenchmarks.slice(0, 5),
    summary,
  };
}
