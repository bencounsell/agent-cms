import {
  canonicalPhrase,
  containsPhrase,
  type KeywordIndex,
  keywordOverlap,
} from "../analysis/keywords.ts";
import type { CmsConfig, CollectionConfig } from "../config/schema.ts";
import type { Entry, EntryFrontmatter, FaqItem, MetadataField } from "../content/schema.ts";
import {
  analyzeMarkdown,
  type MarkdownAnalysis,
  nodeText,
  parseMarkdown,
} from "../markdown/analyze.ts";
import { countWords, readingTimeMinutes, slugify, truncateAtWord, uniq } from "../util/text.ts";
import { buildJsonLd } from "./jsonld.ts";

export interface DeterministicContext {
  config: CmsConfig;
  collection: CollectionConfig;
  corpus: Entry[];
  analyses: Map<string, MarkdownAnalysis>;
  index: KeywordIndex;
  author?: Entry;
}

export interface DeterministicResult {
  values: Partial<EntryFrontmatter>;
  review: string[];
  notes: string[];
}

const key = (e: Entry) => `${e.collection}/${e.slug}`;

/** Metadata that can be derived from the text alone, without any model. */
export function deterministicMetadata(
  entry: Entry,
  analysis: MarkdownAnalysis,
  ctx: DeterministicContext,
  fields: ReadonlySet<MetadataField>,
): DeterministicResult {
  const { config, collection } = ctx;
  const fm = entry.frontmatter;
  const values: Partial<EntryFrontmatter> = {};
  const review: string[] = [];
  const notes: string[] = [];
  const policy = collection.metadata;

  const keywords = ctx.index
    .extract(
      {
        id: key(entry),
        title: fm.title,
        headings: analysis.headings.map((h) => h.text),
        text: analysis.text,
      },
      policy.maxKeywords,
    )
    .map((k) => k.phrase);

  if (fields.has("readingTime")) {
    values.wordCount = analysis.wordCount;
    values.readingTime = readingTimeMinutes(analysis.wordCount);
  }

  if (fields.has("excerpt")) {
    values.excerpt = analysis.firstParagraph
      ? truncateAtWord(analysis.firstParagraph, 200)
      : truncateAtWord(analysis.text, 200);
  }

  if (fields.has("description")) {
    const base = analysis.firstParagraph.length >= 50 ? analysis.firstParagraph : analysis.text;
    values.description = base
      ? describeFromText(base, config.seo.descriptionLength.max)
      : `${fm.title} – ${config.site.name}`;
    review.push("description");
    notes.push(
      "description was derived from the opening paragraph; a model or editor should rewrite it as a proper meta description",
    );
  }

  if (fields.has("keywords")) {
    values.keywords = keywords;
    if (keywords[0])
      values.seo = { ...(fm.seo ?? {}), focusKeyword: fm.seo?.focusKeyword ?? keywords[0] };
  }

  if (fields.has("category")) {
    const guess = guessCategory(fm, analysis, keywords, config);
    if (guess) {
      values.category = guess.name;
      if (guess.confidence <= 0.5) review.push("category");
    } else {
      review.push("category");
      notes.push(
        config.taxonomy.categories.length
          ? "no taxonomy category matched the content"
          : "no taxonomy is configured; add categories to taxonomy.categories so they can be assigned automatically",
      );
    }
  }

  if (fields.has("tags")) {
    values.tags = suggestTags(fm, analysis, keywords, ctx, policy.maxTags);
    if (values.tags.length === 0) review.push("tags");
  }

  if (fields.has("social")) {
    const title = fm.seo?.title ?? fm.title;
    const description = fm.seo?.description ?? fm.description ?? values.description ?? "";
    values.social = {
      og: {
        title,
        description,
        image: fm.image,
        type: collection.kind === "post" || collection.kind === "doc" ? "article" : "website",
      },
      twitter: {
        card: fm.image ? "summary_large_image" : "summary",
        title,
        description,
        image: fm.image,
        site: config.site.social.twitter,
      },
    };
  }

  if (fields.has("aeo")) {
    const aeo = extractAeo(entry, analysis);
    values.aeo = { ...(fm.aeo ?? {}), ...aeo };
    if (!aeo.answer) {
      review.push("aeo");
      notes.push(
        "no direct answer could be extracted; write a 40–70 word answer paragraph at the top or let a model draft aeo.answer",
      );
    }
  }

  if (fields.has("related")) {
    values.related = relatedEntries(entry, analysis, keywords, ctx, 3);
  }

  if (fields.has("schema")) {
    // JSON-LD is regenerated at build time; here we only validate that nothing blocks it.
    // Keep any human-authored override in `schema` untouched.
  }

  return { values, review: uniq(review), notes };
}

export function guessCategory(
  fm: EntryFrontmatter,
  analysis: MarkdownAnalysis,
  keywords: string[],
  config: CmsConfig,
): { name: string; confidence: number } | undefined {
  const categories = config.taxonomy.categories;
  if (categories.length === 0) return undefined;
  const haystack = `${fm.title} ${fm.title} ${analysis.headings.map((h) => h.text).join(" ")} ${keywords.join(" ")} ${fm.tags.join(" ")} ${analysis.text.slice(0, 3000)}`;
  let best: { name: string; score: number } | undefined;
  for (const c of categories) {
    const terms = uniq([c.name, ...c.keywords].map(canonicalPhrase)).filter(Boolean);
    let score = 0;
    for (const t of terms) {
      if (containsPhrase(fm.title, t)) score += 3;
      if (containsPhrase(haystack, t)) score += 1;
      // A category term inside one of the document's own keywords is a strong signal; the
      // reverse (a short keyword inside a long category term) is not.
      if (keywords.some((k) => containsPhrase(k, t))) score += 2;
    }
    if (score > 0 && (!best || score > best.score)) best = { name: c.name, score };
  }
  if (!best) return undefined;
  return { name: best.name, confidence: Math.min(1, best.score / 6) };
}

export function suggestTags(
  fm: EntryFrontmatter,
  analysis: MarkdownAnalysis,
  keywords: string[],
  ctx: DeterministicContext,
  max: number,
): string[] {
  const taxonomy = ctx.config.taxonomy;
  const existing = new Map<string, number>();
  for (const e of ctx.corpus)
    for (const t of e.frontmatter.tags) existing.set(t, (existing.get(t) ?? 0) + 1);
  const pool = taxonomy.tagPolicy === "closed" ? taxonomy.allowedTags : [...existing.keys()];
  const text = `${fm.title} ${analysis.text}`;
  const matched = pool
    .filter((t) => containsPhrase(text, t.replace(/-/g, " ")))
    .sort((a, b) => (existing.get(b) ?? 0) - (existing.get(a) ?? 0));
  const out = uniq([...fm.tags, ...matched]);
  if (taxonomy.tagPolicy === "open") {
    // Only specific phrases make good tags: multi-word keywords, or single words the title uses.
    let added = 0;
    for (const k of keywords) {
      if (out.length >= max || added >= 5) break;
      const words = k.split(" ").length;
      if (words > 3) continue;
      if (words === 1 && !containsPhrase(fm.title, k)) continue;
      out.push(slugify(k));
      added++;
    }
  }
  return uniq(out.map((t) => slugify(t)).filter(Boolean)).slice(0, max);
}

export function relatedEntries(
  entry: Entry,
  analysis: MarkdownAnalysis,
  keywords: string[],
  ctx: DeterministicContext,
  max: number,
): string[] {
  const concepts = (kws: string[], tags: string[], category?: string) =>
    uniq(
      [...kws, ...tags.map((t) => t.replace(/-/g, " ")), ...(category ? [category] : [])].map(
        canonicalPhrase,
      ),
    ).filter(Boolean);
  const mine = concepts(keywords, entry.frontmatter.tags, entry.frontmatter.category);
  const text = `${entry.frontmatter.title} ${analysis.text}`;
  const scored: { slug: string; score: number }[] = [];
  for (const other of ctx.corpus) {
    if (other.collection !== entry.collection || other.slug === entry.slug) continue;
    if (other.frontmatter.status === "archived") continue;
    const theirs = concepts(
      other.frontmatter.keywords,
      other.frontmatter.tags,
      other.frontmatter.category,
    );
    let score = keywordOverlap(mine, theirs);
    if (entry.frontmatter.category && entry.frontmatter.category === other.frontmatter.category)
      score += 0.2;
    if (containsPhrase(text, other.frontmatter.title)) score += 0.3;
    const theirFocus = other.frontmatter.seo?.focusKeyword ?? other.frontmatter.keywords[0];
    if (theirFocus && containsPhrase(text, theirFocus)) score += 0.3;
    if (score > 0.2) scored.push({ slug: other.slug, score });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((s) => s.slug);
}

/** Pull answer, takeaways, FAQ and questions out of the content when the author already wrote them. */
export function extractAeo(
  entry: Entry,
  analysis: MarkdownAnalysis,
): {
  answer?: string;
  keyTakeaways?: string[];
  faq?: FaqItem[];
  questions?: string[];
} {
  const out: ReturnType<typeof extractAeo> = {};
  const fm = entry.frontmatter;
  const firstWords = countWords(analysis.firstParagraph);
  if (fm.aeo?.answer) out.answer = fm.aeo.answer;
  else if (firstWords >= 25 && firstWords <= 80) out.answer = analysis.firstParagraph;

  const tree = parseMarkdown(entry.body);
  const children = tree.children ?? [];
  const takeaways: string[] = [];
  const faq: FaqItem[] = [];
  let mode: "none" | "takeaways" | "faq" = "none";
  let pendingQuestion: string | undefined;
  let faqDepth = 0;
  for (const node of children) {
    if (node.type === "heading") {
      const text = nodeText(node).trim();
      const depth = node.depth ?? 1;
      if (mode === "faq" && depth > faqDepth && /\?$/.test(text)) {
        pendingQuestion = text;
        continue;
      }
      if (/\b(key takeaways|takeaways|tl;?dr|in short|quick answer)\b/i.test(text)) {
        mode = "takeaways";
        continue;
      }
      if (/\b(faq|faqs|frequently asked questions|common questions|q&a)\b/i.test(text)) {
        mode = "faq";
        faqDepth = depth;
        pendingQuestion = undefined;
        continue;
      }
      if (depth <= faqDepth || mode === "takeaways") {
        mode = "none";
        pendingQuestion = undefined;
      }
      continue;
    }
    if (mode === "takeaways" && node.type === "list") {
      for (const item of node.children ?? []) takeaways.push(nodeText(item).trim());
      mode = "none";
      continue;
    }
    if (mode === "faq") {
      if (node.type === "paragraph") {
        const text = nodeText(node).trim();
        const boldQ =
          node.children?.[0]?.type === "strong" ? nodeText(node.children[0]).trim() : undefined;
        if (pendingQuestion) {
          faq.push({ question: pendingQuestion, answer: text });
          pendingQuestion = undefined;
        } else if (boldQ && /\?$/.test(boldQ)) {
          const answer = text.slice(boldQ.length).trim();
          if (answer) faq.push({ question: boldQ, answer });
          else pendingQuestion = boldQ;
        }
      } else if (node.type === "list" && faq.length === 0) {
        for (const item of node.children ?? []) {
          const text = nodeText(item).trim();
          const m = text.match(/^(.+?\?)\s+(.+)$/);
          if (m) faq.push({ question: m[1]!, answer: m[2]! });
        }
      }
    }
  }
  if (takeaways.length) out.keyTakeaways = takeaways;
  else if (fm.aeo?.keyTakeaways?.length) out.keyTakeaways = fm.aeo.keyTakeaways;
  if (faq.length) out.faq = faq;
  else if (fm.aeo?.faq?.length) out.faq = fm.aeo.faq;
  const questions = uniq([
    ...(fm.aeo?.questions ?? []),
    ...analysis.headings.filter((h) => h.isQuestion && /\?$/.test(h.text)).map((h) => h.text),
    ...faq.map((f) => f.question),
  ]);
  if (questions.length) out.questions = questions.slice(0, 8);
  return out;
}

/** Whole sentences up to the limit; falls back to a word-boundary cut with an ellipsis. */
export function describeFromText(text: string, max: number): string {
  const sentences = text
    .match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g)
    ?.map((s) => s.trim())
    .filter(Boolean) ?? [text];
  let out = "";
  for (const s of sentences) {
    const next = out ? `${out} ${s}` : s;
    if (next.length > max) break;
    out = next;
  }
  if (out.length >= Math.min(60, max / 2)) return out;
  return truncateAtWord(text, max);
}

export function analysisFor(entry: Entry, config: CmsConfig): MarkdownAnalysis {
  return analyzeMarkdown(entry.body, { siteUrl: config.site.url });
}

export { buildJsonLd };
