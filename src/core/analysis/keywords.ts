import { isStopword } from "./stopwords.ts";

export interface KeywordCandidate {
  phrase: string;
  score: number;
  count: number;
}

export interface CorpusDoc {
  id: string;
  text: string;
  title?: string;
  headings?: string[];
}

const TOKEN_RE = /[a-z0-9][a-z0-9'’+#.-]*[a-z0-9+#]|[a-z0-9]/g;

function normalize(text: string): string {
  return text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

export function tokenize(text: string): string[] {
  return (normalize(text).match(TOKEN_RE) ?? []).map((t) => t.replace(/^['’]+|['’.]+$/g, ""));
}

/** Split text into segments at sentence and clause boundaries so phrases never span them. */
function segments(text: string): string[][] {
  return normalize(text)
    .split(/[.!?;:()[\]{}"“”\n|•·]+|\s[-–—]\s|,\s/)
    .map((s) => s.match(TOKEN_RE) ?? [])
    .map((toks) => toks.map((t) => t.replace(/^['’]+|['’.]+$/g, "")))
    .filter((toks) => toks.length > 0);
}

function isContentToken(t: string): boolean {
  return t.length >= 3 && !isStopword(t) && !/^\d+$/.test(t);
}

/** Candidate phrases: unigrams, bigrams and trigrams that start and end with content tokens. */
export function phrases(tokens: string[], maxN = 3): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t0 = tokens[i]!;
    if (!isContentToken(t0)) continue;
    out.push(t0);
    for (let n = 2; n <= maxN && i + n <= tokens.length; n++) {
      const slice = tokens.slice(i, i + n);
      const last = slice[slice.length - 1]!;
      if (!isContentToken(last)) continue;
      if (slice.slice(1, -1).some((t) => t.length < 2)) continue;
      out.push(slice.join(" "));
    }
  }
  return out;
}

export function phrasesInText(text: string, maxN = 3): string[] {
  return segments(text).flatMap((seg) => phrases(seg, maxN));
}

function counts(items: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const i of items) m.set(i, (m.get(i) ?? 0) + 1);
  return m;
}

function isSubPhrase(short: string, long: string): boolean {
  return short !== long && ` ${long} `.includes(` ${short} `);
}

export class KeywordIndex {
  private readonly df = new Map<string, number>();
  private readonly n: number;

  constructor(corpus: CorpusDoc[]) {
    this.n = corpus.length;
    for (const doc of corpus) {
      const seen = new Set(phrasesInText(`${doc.title ?? ""}. ${doc.text}`));
      for (const p of seen) this.df.set(p, (this.df.get(p) ?? 0) + 1);
    }
  }

  idf(phrase: string): number {
    const df = this.df.get(phrase) ?? 0;
    return Math.log((this.n + 1) / (df + 1)) + 1;
  }

  documentFrequency(phrase: string): number {
    return this.df.get(phrase) ?? 0;
  }

  extract(doc: CorpusDoc, max = 10): KeywordCandidate[] {
    const total = Math.max(1, tokenize(doc.text).length);
    const tf = counts(phrasesInText(doc.text));
    const titlePhrases = new Set(phrasesInText(doc.title ?? ""));
    const headingPhrases = new Set(phrasesInText((doc.headings ?? []).join(". ")));
    const scored: KeywordCandidate[] = [];
    for (const [phrase, count] of tf) {
      const words = phrase.split(" ").length;
      const emphasized = titlePhrases.has(phrase) || headingPhrases.has(phrase);
      // A phrase seen once in the body is noise unless the title or a heading also carries it.
      if (count < 2 && !emphasized) continue;
      if (words === 3 && count < 3 && !emphasized) continue;
      let score = (count / total) * this.idf(phrase);
      // Longer phrases are more specific; title and headings signal topical focus.
      score *= words === 1 ? 1 : words === 2 ? 2.2 : 2.8;
      if (titlePhrases.has(phrase)) score *= 3;
      if (headingPhrases.has(phrase)) score *= 1.6;
      scored.push({ phrase, score, count });
    }
    scored.sort((a, b) => b.score - a.score || b.phrase.length - a.phrase.length);
    const chosen: KeywordCandidate[] = [];
    for (const c of scored) {
      // Suppress a sub-phrase that mostly occurs inside an already chosen longer phrase,
      // and a longer phrase that merely wraps a chosen one without adding frequency.
      const redundant = chosen.some(
        (k) =>
          (isSubPhrase(c.phrase, k.phrase) && k.count >= c.count * 0.6) ||
          (isSubPhrase(k.phrase, c.phrase) && c.count <= 1),
      );
      if (redundant) continue;
      chosen.push(c);
      if (chosen.length >= max) break;
    }
    return chosen;
  }
}

export function extractKeywords(doc: CorpusDoc, corpus: CorpusDoc[], max = 10): KeywordCandidate[] {
  const index = new KeywordIndex(corpus.some((d) => d.id === doc.id) ? corpus : [...corpus, doc]);
  return index.extract(doc, max);
}

/** Share of the smaller list that also appears in the larger one (0..1). */
export function keywordOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a.map((x) => canonicalPhrase(x)));
  const sb = new Set(b.map((x) => canonicalPhrase(x)));
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / Math.min(sa.size, sb.size);
}

/** Lowercase, accents stripped, hyphens treated as spaces: "Agent-First CMS" -> "agent first cms". */
export function canonicalPhrase(phrase: string): string {
  return tokenize(phrase.replace(/(\w)[-–](\w)/g, "$1 $2")).join(" ");
}

export function containsPhrase(text: string, phrase: string): boolean {
  const p = canonicalPhrase(phrase);
  if (!p) return false;
  return ` ${canonicalPhrase(text)} `.includes(` ${p} `);
}
