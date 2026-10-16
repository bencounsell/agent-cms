import { canonicalPhrase, containsPhrase, phrasesInText } from "../analysis/keywords.ts";
import type { CmsConfig } from "../config/schema.ts";
import type { Entry } from "../content/schema.ts";
import type { MarkdownAnalysis } from "../markdown/analyze.ts";
import { daysSince, nowIso } from "../util/dates.ts";
import { titleCase, uniq } from "../util/text.ts";
import type {
  ComparisonReport,
  CompetitorRecord,
  CompetitorSummary,
  Opportunity,
  PageRecord,
  TopicGap,
} from "./types.ts";

const WINDOW_DAYS = 90;

function cadence(dates: (string | undefined)[], now: Date): number {
  const recent = dates.filter((d) => {
    const age = daysSince(d, now);
    return age !== undefined && age >= 0 && age <= WINDOW_DAYS;
  }).length;
  return Math.round((recent / (WINDOW_DAYS / 30)) * 10) / 10;
}

function share(items: boolean[]): number {
  return items.length ? Math.round((items.filter(Boolean).length / items.length) * 100) / 100 : 0;
}

export function summarizeCompetitor(rec: CompetitorRecord, now = new Date()): CompetitorSummary {
  const pages = rec.latest?.pages ?? [];
  const topicCounts = new Map<string, number>();
  for (const p of pages)
    for (const k of p.keywords.slice(0, 5)) topicCounts.set(k, (topicCounts.get(k) ?? 0) + 1);
  return {
    host: rec.host,
    name: rec.name,
    url: rec.url,
    pages: pages.length,
    cadencePerMonth: cadence(
      pages.map((p) => p.publishedAt ?? p.modifiedAt),
      now,
    ),
    avgWordCount: pages.length
      ? Math.round(pages.reduce((n, p) => n + p.wordCount, 0) / pages.length)
      : 0,
    faqShare: share(pages.map((p) => p.hasFaq)),
    schemaShare: share(pages.map((p) => p.schemaTypes.length > 0)),
    questionHeadingShare: share(pages.map((p) => p.questionHeadings > 0)),
    lastFetched: rec.latest?.fetchedAt,
    recent: [...pages]
      .sort((a, b) =>
        (b.publishedAt ?? b.modifiedAt ?? "").localeCompare(a.publishedAt ?? a.modifiedAt ?? ""),
      )
      .slice(0, 5)
      .map((p) => ({ url: p.url, title: p.title, publishedAt: p.publishedAt ?? p.modifiedAt })),
    topTopics: [...topicCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([t]) => t),
  };
}

export interface CompareInput {
  config: CmsConfig;
  entries: Entry[];
  analyses: Map<string, MarkdownAnalysis>;
  competitors: CompetitorRecord[];
  now?: Date;
}

export function compareCompetitors(input: CompareInput): ComparisonReport {
  const now = input.now ?? new Date();
  const ours = input.entries.filter(
    (e) => e.frontmatter.status === "published" || e.frontmatter.status === "review",
  );
  const ourText = ours.map((e) => {
    const a = input.analyses.get(`${e.collection}/${e.slug}`);
    return `${e.frontmatter.title} ${e.frontmatter.keywords.join(" ")} ${e.frontmatter.tags.join(" ")} ${a?.headings.map((h) => h.text).join(" ") ?? ""} ${a?.text.slice(0, 4000) ?? ""}`;
  });
  const ourSummary: ComparisonReport["ours"] = {
    pages: ours.length,
    cadencePerMonth: cadence(
      ours.map((e) => e.frontmatter.publishedAt),
      now,
    ),
    avgWordCount: ours.length
      ? Math.round(
          ours.reduce(
            (n, e) => n + (input.analyses.get(`${e.collection}/${e.slug}`)?.wordCount ?? 0),
            0,
          ) / ours.length,
        )
      : 0,
    faqShare: share(
      ours.map(
        (e) =>
          (e.frontmatter.aeo?.faq?.length ?? 0) > 0 ||
          Boolean(input.analyses.get(`${e.collection}/${e.slug}`)?.hasFaqSection),
      ),
    ),
    schemaShare: 1,
    questionHeadingShare: share(
      ours.map(
        (e) =>
          input.analyses.get(`${e.collection}/${e.slug}`)?.headings.some((h) => h.isQuestion) ??
          false,
      ),
    ),
    recent: [...ours]
      .sort((a, b) =>
        (b.frontmatter.publishedAt ?? "").localeCompare(a.frontmatter.publishedAt ?? ""),
      )
      .slice(0, 5)
      .map((e) => ({
        url: e.url,
        title: e.frontmatter.title,
        publishedAt: e.frontmatter.publishedAt,
      })),
    topTopics: topTopics(ours),
  };

  const competitors = input.competitors.map((c) => summarizeCompetitor(c, now));

  // Topic gaps: phrases competitors emphasise that our corpus never mentions.
  const topicPages = new Map<string, { host: string; url: string; title?: string }[]>();
  for (const rec of input.competitors) {
    for (const page of rec.latest?.pages ?? []) {
      const topics = uniq([...page.keywords.slice(0, 6), ...titlePhrases(page)]);
      for (const t of topics) {
        const c = canonicalPhrase(t);
        if (c.split(" ").length < 2 && c.length < 6) continue;
        const list = topicPages.get(c) ?? [];
        if (!list.some((x) => x.url === page.url))
          list.push({ host: rec.host, url: page.url, title: page.title });
        topicPages.set(c, list);
      }
    }
  }
  const gaps: TopicGap[] = [];
  for (const [topic, pages] of topicPages) {
    const coverage = ourText.filter((t) => containsPhrase(t, topic)).length;
    if (coverage > 0) continue;
    const hosts = new Set(pages.map((p) => p.host)).size;
    const score = pages.length + hosts * 2 + (topic.split(" ").length >= 2 ? 1 : 0);
    gaps.push({ topic, score, competitorPages: pages.slice(0, 5), ourCoverage: coverage });
  }
  gaps.sort((a, b) => b.score - a.score);
  const topGaps = dedupeGaps(gaps).slice(0, 25);

  const opportunities: Opportunity[] = [];
  const strengths: string[] = [];
  const weaknesses: string[] = [];
  for (const gap of topGaps.slice(0, 8)) {
    opportunities.push({
      type: "new_topic",
      title: titleCase(gap.topic),
      reason: `${gap.competitorPages.length} competitor page(s) cover "${gap.topic}" and nothing on the site mentions it.`,
      evidence: gap.competitorPages.map((p) => `${p.host}: ${p.title ?? p.url}`),
      targetKeywords: [gap.topic],
      priority: gap.score >= 6 ? 1 : 2,
    });
  }
  const avgCompetitor = <K extends keyof CompetitorSummary>(k: K): number => {
    const vals = competitors
      .map((c) => c[k])
      .filter((v): v is number & CompetitorSummary[K] => typeof v === "number" && !Number.isNaN(v));
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  };
  const theirFaq = avgCompetitor("faqShare");
  if (theirFaq > ourSummary.faqShare + 0.2) {
    opportunities.push({
      type: "structure",
      title: "Add FAQ sections to key posts",
      reason: `${Math.round(theirFaq * 100)}% of competitor pages carry an FAQ versus ${Math.round(ourSummary.faqShare * 100)}% of ours; FAQs win answer-engine citations.`,
      evidence: competitors
        .filter((c) => c.faqShare > 0.3)
        .map((c) => `${c.host}: ${Math.round(c.faqShare * 100)}% with FAQ`),
      targetKeywords: [],
      priority: 1,
    });
    weaknesses.push("Fewer FAQ sections than competitors");
  } else if (ourSummary.faqShare > theirFaq) strengths.push("More FAQ coverage than competitors");
  const theirCadence = avgCompetitor("cadencePerMonth");
  if (theirCadence > ourSummary.cadencePerMonth * 1.5 && theirCadence >= 1) {
    opportunities.push({
      type: "cadence",
      title: "Publish more often",
      reason: `Competitors publish about ${theirCadence.toFixed(1)} pieces a month versus ${ourSummary.cadencePerMonth.toFixed(1)} here.`,
      evidence: competitors.map((c) => `${c.host}: ${c.cadencePerMonth}/month`),
      targetKeywords: [],
      priority: 2,
    });
    weaknesses.push("Lower publishing cadence");
  } else if (ourSummary.cadencePerMonth >= theirCadence && ourSummary.cadencePerMonth > 0)
    strengths.push("Publishing cadence matches or beats competitors");
  const theirWords = avgCompetitor("avgWordCount");
  if (theirWords > ourSummary.avgWordCount * 1.3 && theirWords > 600) {
    opportunities.push({
      type: "depth",
      title: "Go deeper on core topics",
      reason: `Competitor pages average ${theirWords} words versus ${ourSummary.avgWordCount} here.`,
      evidence: competitors.map((c) => `${c.host}: ~${c.avgWordCount} words`),
      targetKeywords: [],
      priority: 2,
    });
    weaknesses.push("Shorter content than competitors");
  } else if (ourSummary.avgWordCount > theirWords && ourSummary.avgWordCount > 0)
    strengths.push("Deeper content than competitors");
  const theirQ = avgCompetitor("questionHeadingShare");
  if (theirQ > ourSummary.questionHeadingShare + 0.2) {
    opportunities.push({
      type: "questions",
      title: "Use question-form headings",
      reason: `${Math.round(theirQ * 100)}% of competitor pages use headings phrased as questions versus ${Math.round(ourSummary.questionHeadingShare * 100)}% here.`,
      evidence: [],
      targetKeywords: [],
      priority: 3,
    });
  }
  const theirSchema = avgCompetitor("schemaShare");
  if (theirSchema < 0.5)
    strengths.push(
      `Structured data on every page (competitors: ${Math.round(theirSchema * 100)}%)`,
    );

  const summary = [
    `${competitors.length} competitor(s), ${competitors.reduce((n, c) => n + c.pages, 0)} pages analysed.`,
    `${topGaps.length} topic gap(s) found.`,
    opportunities.length
      ? `Top opportunity: ${opportunities[0]!.title}.`
      : "No structural gaps detected.",
  ].join(" ");

  return {
    generatedAt: nowIso(),
    ours: ourSummary,
    competitors,
    gaps: topGaps,
    opportunities,
    strengths,
    weaknesses,
    summary,
  };
}

function titlePhrases(page: PageRecord): string[] {
  const title = page.h1 ?? page.title ?? "";
  return phrasesInText(title.replace(/\s[|–-]\s.*$/, ""), 3).filter(
    (p) => p.split(" ").length >= 2,
  );
}

function topTopics(entries: Entry[]): string[] {
  const counts = new Map<string, number>();
  for (const e of entries)
    for (const k of [...e.frontmatter.keywords.slice(0, 5), ...e.frontmatter.tags])
      counts.set(k, (counts.get(k) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([t]) => t);
}

/** Collapse overlapping topics, preferring the more specific phrase when it scores nearly as well. */
function dedupeGaps(gaps: TopicGap[]): TopicGap[] {
  const out: TopicGap[] = [];
  for (const g of gaps) {
    const idx = out.findIndex(
      (o) => ` ${o.topic} `.includes(` ${g.topic} `) || ` ${g.topic} `.includes(` ${o.topic} `),
    );
    if (idx === -1) {
      out.push(g);
      continue;
    }
    const existing = out[idx]!;
    if (g.topic.length > existing.topic.length && g.score >= existing.score * 0.8) out[idx] = g;
  }
  return out;
}
