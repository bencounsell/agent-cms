import type { CmsConfig, CollectionConfig } from "../config/schema.ts";
import type { Entry } from "../content/schema.ts";
import type { MarkdownAnalysis } from "../markdown/analyze.ts";
import { daysSince } from "../util/dates.ts";
import { countWords } from "../util/text.ts";
import type { DuplicateReport } from "./duplicates.ts";
import { containsPhrase } from "./keywords.ts";
import { entryKey, type LinkGraph } from "./links.ts";
import { analyzeReadability, type ReadabilityResult } from "./readability.ts";

export type AuditArea = "seo" | "aeo" | "readability" | "links" | "freshness" | "page";
export type Severity = "error" | "warning" | "info";

export interface AuditCheck {
  id: string;
  area: AuditArea;
  severity: Severity;
  passed: boolean;
  weight: number;
  message: string;
  /** Concrete, agent-executable instruction. */
  fix?: string;
  evidence?: unknown;
}

export interface AuditScores {
  seo: number;
  aeo: number;
  readability: number;
  links: number;
  freshness: number;
  /** Rendered-page checks; present when page rendering is enabled. */
  page?: number;
  overall: number;
}

export interface AuditResult {
  collection: string;
  slug: string;
  title: string;
  url: string;
  status: string;
  scores: AuditScores;
  checks: AuditCheck[];
  failed: AuditCheck[];
  summary: string;
  publishable: boolean;
  focusKeyword?: string;
  stats: {
    wordCount: number;
    readingTime?: number;
    headings: number;
    internalLinks: number;
    externalLinks: number;
    inboundLinks: number;
    images: number;
    readability: ReadabilityResult;
  };
}

export interface AuditContext {
  config: CmsConfig;
  collection: CollectionConfig;
  linkGraph?: LinkGraph;
  duplicates?: DuplicateReport;
  now?: Date;
}

type CheckInput = Omit<AuditCheck, "passed"> & { passed: boolean };

export function focusKeywordOf(entry: Entry): string | undefined {
  return entry.frontmatter.seo?.focusKeyword ?? entry.frontmatter.keywords[0];
}

export function auditEntry(
  entry: Entry,
  analysis: MarkdownAnalysis,
  ctx: AuditContext,
): AuditResult {
  const { config, collection } = ctx;
  const fm = entry.frontmatter;
  const seoCfg = config.seo;
  const checks: AuditCheck[] = [];
  const add = (c: CheckInput) => checks.push(c);
  const kind = collection.kind;
  const isArticle = kind === "post" || kind === "doc" || kind === "custom";
  const isAuthor = kind === "author";
  const title = fm.seo?.title ?? fm.title;
  const description = fm.seo?.description ?? fm.description ?? "";
  const focus = focusKeywordOf(entry);
  const readability = analyzeReadability(analysis.text, analysis.paragraphs);
  const internal = analysis.links.filter((l) => l.internal);
  const external = analysis.links.filter((l) => !l.internal);
  const inbound = ctx.linkGraph?.inbound.get(entryKey(entry)) ?? 0;
  const key = entryKey(entry);

  // ---------------------------------------------------------------- SEO
  add({
    id: "seo.title.length",
    area: "seo",
    severity: title.length > seoCfg.titleLength.max ? "warning" : "info",
    weight: title.length > seoCfg.titleLength.max ? 6 : 3,
    passed: title.length >= seoCfg.titleLength.min && title.length <= seoCfg.titleLength.max,
    message: `Title is ${title.length} characters (target ${seoCfg.titleLength.min}–${seoCfg.titleLength.max}).`,
    fix:
      title.length > seoCfg.titleLength.max
        ? `Set seo.title to a version under ${seoCfg.titleLength.max} characters that keeps the focus keyword.`
        : `Set seo.title to a more descriptive title of at least ${seoCfg.titleLength.min} characters.`,
    evidence: { title },
  });
  add({
    id: "seo.description.present",
    area: "seo",
    severity: "error",
    weight: 10,
    passed: description.length > 0,
    message: description ? "Meta description is set." : "No meta description.",
    fix: "Run enrich_metadata or set `description` (70–160 characters, includes the focus keyword, ends with a reason to click).",
  });
  if (description) {
    add({
      id: "seo.description.length",
      area: "seo",
      severity: "warning",
      weight: 5,
      passed:
        description.length >= seoCfg.descriptionLength.min &&
        description.length <= seoCfg.descriptionLength.max,
      message: `Meta description is ${description.length} characters (target ${seoCfg.descriptionLength.min}–${seoCfg.descriptionLength.max}).`,
      fix: "Rewrite `description` to fit the target length.",
    });
  }
  const h1s = analysis.headings.filter((h) => h.depth === 1);
  add({
    id: "seo.headings.no-h1-in-body",
    area: "seo",
    severity: "warning",
    weight: 3,
    passed: h1s.length === 0,
    message:
      h1s.length === 0
        ? "Body has no H1 (the title is the H1)."
        : `Body contains ${h1s.length} H1 heading(s); the rendered title already is the H1.`,
    fix: "Demote body H1 headings (#) to H2 (##).",
    evidence: h1s.map((h) => h.text),
  });
  const skips: string[] = [];
  let prev = 1;
  for (const h of analysis.headings) {
    if (h.depth > prev + 1) skips.push(`${"#".repeat(h.depth)} ${h.text}`);
    prev = h.depth;
  }
  add({
    id: "seo.headings.hierarchy",
    area: "seo",
    severity: "info",
    weight: 2,
    passed: skips.length === 0,
    message:
      skips.length === 0
        ? "Heading levels are sequential."
        : `Heading levels skip (${skips.length}).`,
    fix: "Do not jump from H2 to H4; keep heading levels sequential.",
    evidence: skips,
  });
  if (isArticle) {
    add({
      id: "seo.headings.present",
      area: "seo",
      severity: "warning",
      weight: 4,
      passed:
        analysis.headings.filter((h) => h.depth === 2).length >= 2 || analysis.wordCount < 300,
      message: `${analysis.headings.filter((h) => h.depth === 2).length} H2 sections.`,
      fix: "Break the content into at least two H2 sections with descriptive headings.",
    });
  }
  if (focus) {
    add({
      id: "seo.keyword.title",
      area: "seo",
      severity: "warning",
      weight: 5,
      passed: containsPhrase(title, focus),
      message: `Focus keyword "${focus}" ${containsPhrase(title, focus) ? "appears" : "is missing"} in the title.`,
      fix: `Include "${focus}" in the title or seo.title, ideally near the start.`,
    });
    add({
      id: "seo.keyword.description",
      area: "seo",
      severity: "info",
      weight: 3,
      passed: containsPhrase(description, focus),
      message: `Focus keyword ${containsPhrase(description, focus) ? "appears" : "is missing"} in the meta description.`,
      fix: `Mention "${focus}" naturally in the description.`,
    });
    add({
      id: "seo.keyword.intro",
      area: "seo",
      severity: "info",
      weight: 3,
      passed: containsPhrase(analysis.firstParagraph, focus),
      message: `Focus keyword ${containsPhrase(analysis.firstParagraph, focus) ? "appears" : "is missing"} in the first paragraph.`,
      fix: `Use "${focus}" in the opening paragraph.`,
    });
    add({
      id: "seo.keyword.slug",
      area: "seo",
      severity: "info",
      weight: 2,
      passed: containsPhrase(entry.slug.replace(/-/g, " "), focus),
      message: `Focus keyword ${containsPhrase(entry.slug.replace(/-/g, " "), focus) ? "appears" : "is missing"} in the slug.`,
      fix: "Consider a slug that contains the focus keyword (only before publishing; changing a published slug breaks links).",
    });
  } else {
    add({
      id: "seo.keyword.defined",
      area: "seo",
      severity: "warning",
      weight: 5,
      passed: false,
      message: "No focus keyword or keywords defined.",
      fix: "Run enrich_metadata to extract keywords, or set seo.focusKeyword.",
    });
  }
  const missingAlt = analysis.images.filter((i) => !i.alt);
  if (analysis.images.length > 0) {
    add({
      id: "seo.images.alt",
      area: "seo",
      severity: "warning",
      weight: 3,
      passed: missingAlt.length === 0,
      message:
        missingAlt.length === 0
          ? "All images have alt text."
          : `${missingAlt.length} image(s) without alt text.`,
      fix: "Add descriptive alt text to every image.",
      evidence: missingAlt.map((i) => i.url),
    });
  }
  if (isArticle) {
    add({
      id: "seo.image.featured",
      area: "seo",
      severity: "info",
      weight: 3,
      passed: Boolean(fm.image),
      message: fm.image ? "Featured image set." : "No featured image.",
      fix: "Set `image` (and `imageAlt`); it feeds Open Graph, Twitter cards and structured data.",
    });
    add({
      id: "seo.wordcount",
      area: "seo",
      severity: "warning",
      weight: 5,
      passed: analysis.wordCount >= seoCfg.targetWordCount * 0.6,
      message: `${analysis.wordCount} words (target ~${seoCfg.targetWordCount}).`,
      fix: `Expand thin sections; aim for about ${seoCfg.targetWordCount} words of useful content.`,
    });
    add({
      id: "seo.category",
      area: "seo",
      severity: "warning",
      weight: 3,
      passed: Boolean(fm.category),
      message: fm.category ? `Category: ${fm.category}.` : "No category.",
      fix: "Set a category (run enrich_metadata or pick one from the taxonomy).",
    });
    add({
      id: "seo.tags",
      area: "seo",
      severity: "info",
      weight: 3,
      passed: fm.tags.length >= 2,
      message: `${fm.tags.length} tag(s).`,
      fix: "Add 2–8 relevant tags.",
    });
  }
  add({
    id: "seo.slug.quality",
    area: "seo",
    severity: "info",
    weight: 2,
    passed: /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.slug) && entry.slug.length <= 75,
    message: `Slug "${entry.slug}".`,
    fix: "Use a short lowercase slug with hyphens and no stopword padding.",
  });
  if (ctx.duplicates) {
    const tKey = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    const dupTitles = (ctx.duplicates.titles.get(tKey) ?? []).filter((k) => k !== key);
    add({
      id: "seo.duplicate.title",
      area: "seo",
      severity: "error",
      weight: 5,
      passed: dupTitles.length === 0,
      message:
        dupTitles.length === 0 ? "Title is unique." : `Title duplicates ${dupTitles.join(", ")}.`,
      fix: "Differentiate the title so each page targets a distinct intent.",
      evidence: dupTitles,
    });
    const dKey = description
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    const dupDesc = dKey
      ? (ctx.duplicates.descriptions.get(dKey) ?? []).filter((k) => k !== key)
      : [];
    add({
      id: "seo.duplicate.description",
      area: "seo",
      severity: "warning",
      weight: 3,
      passed: dupDesc.length === 0,
      message:
        dupDesc.length === 0
          ? "Description is unique."
          : `Description duplicates ${dupDesc.join(", ")}.`,
      fix: "Write a description specific to this entry.",
      evidence: dupDesc,
    });
  }

  // ---------------------------------------------------------------- AEO
  if (isArticle) {
    const firstWords = countWords(analysis.firstParagraph);
    const answerFirst =
      Boolean(fm.aeo?.answer) ||
      (firstWords > 0 &&
        firstWords <= 70 &&
        (!focus || containsPhrase(analysis.firstParagraph, focus)));
    add({
      id: "aeo.answer-first",
      area: "aeo",
      severity: "warning",
      weight: 10,
      passed: answerFirst,
      message: answerFirst
        ? "Content leads with a direct answer."
        : `Opening paragraph is ${firstWords} words and does not read as a direct answer.`,
      fix: "Open with a 40–60 word paragraph that directly answers the main question, then set aeo.answer to that text so answer engines can quote it.",
    });
    const qHeadings = analysis.headings.filter((h) => h.isQuestion);
    add({
      id: "aeo.question-headings",
      area: "aeo",
      severity: "info",
      weight: 5,
      passed: qHeadings.length >= 1,
      message: `${qHeadings.length} heading(s) phrased as questions.`,
      fix: 'Phrase at least one H2 as the question people ask (e.g. "How does X work?") and answer it in the first sentence below.',
    });
    const takeaways = fm.aeo?.keyTakeaways ?? [];
    add({
      id: "aeo.key-takeaways",
      area: "aeo",
      severity: "info",
      weight: 5,
      passed: takeaways.length >= 3 || analysis.hasTakeawaysSection,
      message:
        takeaways.length >= 3 || analysis.hasTakeawaysSection
          ? "Key takeaways present."
          : "No key takeaways / TL;DR.",
      fix: 'Add a 3–5 bullet "Key takeaways" block near the top and mirror it in aeo.keyTakeaways.',
    });
    const faq = fm.aeo?.faq ?? [];
    add({
      id: "aeo.faq",
      area: "aeo",
      severity: "warning",
      weight: 10,
      passed: faq.length >= 2 || analysis.hasFaqSection,
      message:
        faq.length >= 2
          ? `${faq.length} FAQ pairs.`
          : analysis.hasFaqSection
            ? "FAQ section present (no structured pairs yet)."
            : "No FAQ.",
      fix: "Add 3–5 real questions people ask about this topic with concise answers; store them in aeo.faq so FAQPage structured data is generated.",
    });
    if (analysis.hasFaqSection || faq.length > 0) {
      add({
        id: "aeo.faq-schema",
        area: "aeo",
        severity: "info",
        weight: 4,
        passed: faq.length > 0,
        message:
          faq.length > 0
            ? "FAQPage structured data will be generated."
            : "FAQ section exists but aeo.faq is empty, so no FAQPage schema.",
        fix: "Copy the FAQ pairs into aeo.faq.",
      });
    }
    const questions = fm.aeo?.questions ?? [];
    add({
      id: "aeo.target-questions",
      area: "aeo",
      severity: "info",
      weight: 4,
      passed: questions.length >= 2,
      message: `${questions.length} target question(s) defined.`,
      fix: "Set aeo.questions to the 3–6 questions this content should be the answer for.",
    });
    add({
      id: "aeo.sources",
      area: "aeo",
      severity: "info",
      weight: 5,
      passed: external.length >= 2 || (fm.sources?.length ?? 0) >= 2,
      message: `${external.length} external link(s), ${fm.sources?.length ?? 0} listed source(s).`,
      fix: "Cite at least two authoritative sources (link them inline or list them under `sources`).",
    });
    add({
      id: "aeo.author",
      area: "aeo",
      severity: "warning",
      weight: 5,
      passed: Boolean(fm.author),
      message: fm.author ? `Author: ${fm.author}.` : "No author.",
      fix: "Set `author` to an authors-collection slug so Person structured data and E-E-A-T signals are emitted.",
    });
    add({
      id: "aeo.date-modified",
      area: "aeo",
      severity: "info",
      weight: 3,
      passed: Boolean(fm.updatedAt ?? fm.publishedAt),
      message: fm.updatedAt
        ? `Last updated ${fm.updatedAt.slice(0, 10)}.`
        : "No modification date.",
      fix: "Dates are maintained automatically on update; ensure the entry has been saved through the CMS.",
    });
    const avgPara = analysis.paragraphs.length
      ? analysis.paragraphs.reduce((n, p) => n + countWords(p), 0) / analysis.paragraphs.length
      : 0;
    add({
      id: "aeo.scannable",
      area: "aeo",
      severity: "info",
      weight: 4,
      passed:
        avgPara <= 90 && (analysis.lists > 0 || analysis.tables > 0 || analysis.wordCount < 400),
      message: `Average paragraph ${Math.round(avgPara)} words, ${analysis.lists} list(s), ${analysis.tables} table(s).`,
      fix: "Keep paragraphs under ~90 words and use lists or tables for comparisons and steps.",
    });
    if (focus) {
      const definition = new RegExp(`\\b${escapeRe(focus)}\\b\\s+(is|are|means|refers to)\\b`, "i");
      const defined = definition.test(analysis.text.slice(0, 2000)) || Boolean(fm.aeo?.answer);
      add({
        id: "aeo.definition",
        area: "aeo",
        severity: "info",
        weight: 3,
        passed: defined,
        message: defined ? "Key term is defined early." : `"${focus}" is never explicitly defined.`,
        fix: `Add a one-sentence definition: "${focus} is …" within the first 300 words.`,
      });
    }
    add({
      id: "aeo.llms-txt",
      area: "aeo",
      severity: "info",
      weight: 2,
      passed: config.build.llmsTxt,
      message: config.build.llmsTxt
        ? "llms.txt generation is enabled."
        : "llms.txt generation is disabled.",
      fix: "Set build.llmsTxt to true so answer engines get a clean index of the content.",
    });
  }

  // ---------------------------------------------------------------- Readability
  if (isArticle && analysis.wordCount >= 100) {
    add({
      id: "readability.flesch",
      area: "readability",
      severity: "info",
      weight: 5,
      passed: readability.fleschReadingEase >= 50,
      message: `Flesch reading ease ${readability.fleschReadingEase} (${readability.level}).`,
      fix: "Shorten sentences and prefer common words; aim for 60+.",
    });
    add({
      id: "readability.grade",
      area: "readability",
      severity: "info",
      weight: 3,
      passed: readability.fleschKincaidGrade <= 11,
      message: `Flesch–Kincaid grade ${readability.fleschKincaidGrade}.`,
      fix: "Simplify complex sentences; a grade of 8–10 reads well for most audiences.",
    });
    add({
      id: "readability.long-sentences",
      area: "readability",
      severity: "info",
      weight: 3,
      passed: readability.longSentenceRatio <= 0.25,
      message: `${Math.round(readability.longSentenceRatio * 100)}% of sentences exceed 25 words.`,
      fix: "Split long sentences.",
    });
    add({
      id: "readability.passive",
      area: "readability",
      severity: "info",
      weight: 2,
      passed: readability.passiveRatio <= 0.2,
      message: `${Math.round(readability.passiveRatio * 100)}% of sentences look passive.`,
      fix: "Rewrite passive sentences in the active voice.",
    });
    add({
      id: "readability.long-paragraphs",
      area: "readability",
      severity: "info",
      weight: 2,
      passed: readability.longParagraphs === 0,
      message: `${readability.longParagraphs} paragraph(s) over 150 words.`,
      fix: "Break long paragraphs up.",
    });
  }

  // ---------------------------------------------------------------- Links
  if (isArticle) {
    add({
      id: "links.internal",
      area: "links",
      severity: "warning",
      weight: 5,
      passed: internal.length >= seoCfg.minInternalLinks,
      message: `${internal.length} internal link(s) (minimum ${seoCfg.minInternalLinks}).`,
      fix: "Link to related entries (see improve_content for candidates).",
    });
    add({
      id: "links.external",
      area: "links",
      severity: "info",
      weight: 2,
      passed: external.length >= 1,
      message: `${external.length} external link(s).`,
      fix: "Link to at least one authoritative external source.",
    });
    if (ctx.linkGraph) {
      const broken = ctx.linkGraph.broken.filter((b) => b.from === key);
      add({
        id: "links.broken",
        area: "links",
        severity: "error",
        weight: 5,
        passed: broken.length === 0,
        message:
          broken.length === 0
            ? "No broken internal links."
            : `${broken.length} internal link(s) point at nothing.`,
        fix: "Fix or remove the broken links.",
        evidence: broken.map((b) => b.url),
      });
      if (fm.status === "published") {
        add({
          id: "links.inbound",
          area: "links",
          severity: "warning",
          weight: 4,
          passed: inbound > 0,
          message:
            inbound > 0 ? `${inbound} entries link here.` : "Orphan: no other entry links here.",
          fix: "Add links to this entry from related content.",
        });
      }
    }
  }

  // ---------------------------------------------------------------- Freshness
  if (isArticle && fm.status === "published") {
    const age = daysSince(fm.updatedAt ?? fm.publishedAt, ctx.now);
    add({
      id: "freshness.stale",
      area: "freshness",
      severity: "warning",
      weight: 5,
      passed: age === undefined || age <= seoCfg.staleAfterDays,
      message:
        age === undefined
          ? "No dates."
          : `Last updated ${age} days ago (stale after ${seoCfg.staleAfterDays}).`,
      fix: "Review for accuracy, refresh examples and statistics, then save to bump dateModified.",
    });
  }
  if (!isAuthor) {
    add({
      id: "freshness.dates",
      area: "freshness",
      severity: "info",
      weight: 2,
      passed: Boolean(fm.publishedAt) || fm.status !== "published",
      message: fm.publishedAt ? `Published ${fm.publishedAt.slice(0, 10)}.` : "Not published yet.",
      fix: "publishedAt is set automatically when status becomes published.",
    });
  }

  const scores = computeScores(checks);
  const failed = checks.filter((c) => !c.passed).sort(bySeverity);
  const publishable =
    scores.overall >= seoCfg.minAuditScoreToPublish && !failed.some((c) => c.severity === "error");
  const summary = summarize(entry, scores, failed, publishable, seoCfg.minAuditScoreToPublish);
  return {
    collection: entry.collection,
    slug: entry.slug,
    title: fm.title,
    url: entry.url,
    status: fm.status,
    scores,
    checks,
    failed,
    summary,
    publishable,
    focusKeyword: focus,
    stats: {
      wordCount: analysis.wordCount,
      readingTime: fm.readingTime,
      headings: analysis.headings.length,
      internalLinks: internal.length,
      externalLinks: external.length,
      inboundLinks: inbound,
      images: analysis.images.length,
      readability,
    },
  };
}

function computeScores(checks: AuditCheck[]): AuditScores {
  const area = (a: AuditArea): number => {
    const items = checks.filter((c) => c.area === a);
    const total = items.reduce((n, c) => n + c.weight, 0);
    if (total === 0) return 100;
    const got = items.filter((c) => c.passed).reduce((n, c) => n + c.weight, 0);
    return Math.round((got / total) * 100);
  };
  const total = checks.reduce((n, c) => n + c.weight, 0);
  const got = checks.filter((c) => c.passed).reduce((n, c) => n + c.weight, 0);
  return {
    seo: area("seo"),
    aeo: area("aeo"),
    readability: area("readability"),
    links: area("links"),
    freshness: area("freshness"),
    overall: total === 0 ? 100 : Math.round((got / total) * 100),
  };
}

const severityRank: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
function bySeverity(a: AuditCheck, b: AuditCheck): number {
  return severityRank[a.severity] - severityRank[b.severity] || b.weight - a.weight;
}

function summarize(
  entry: Entry,
  s: AuditScores,
  failed: AuditCheck[],
  publishable: boolean,
  min: number,
): string {
  const top = failed
    .slice(0, 3)
    .map((c) => c.message)
    .join(" ");
  const verdict = publishable
    ? `Publishable (score ${s.overall} ≥ ${min}).`
    : `Not ready to publish (score ${s.overall}, threshold ${min}${failed.some((c) => c.severity === "error") ? ", has errors" : ""}).`;
  return `${entry.frontmatter.title}: SEO ${s.seo}, AEO ${s.aeo}, readability ${s.readability}, links ${s.links}. ${verdict} ${top}`.trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
