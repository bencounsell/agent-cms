import { countWords, splitSentences } from "../util/text.ts";

export interface ReadabilityResult {
  fleschReadingEase: number;
  fleschKincaidGrade: number;
  sentences: number;
  words: number;
  syllables: number;
  avgSentenceLength: number;
  longSentenceRatio: number;
  passiveRatio: number;
  longParagraphs: number;
  level: "very easy" | "easy" | "standard" | "fairly difficult" | "difficult" | "very difficult";
}

export function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  if (w.length <= 3) return 1;
  let s = w
    .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "")
    .replace(/^y/, "")
    .match(/[aeiouy]{1,2}/g)?.length ?? 1;
  if (/le$/.test(w) && !/[aeiouy]le$/.test(w)) s++;
  return Math.max(1, s);
}

const PASSIVE_RE = /\b(am|is|are|was|were|be|been|being)\s+(\w+ed|built|done|made|seen|taken|given|written|known|found|shown|held|kept|left|put|set|told|thought|brought|bought|caught|taught|sent|spent|lost|met|read|led|paid|said|sold|understood|won|hit|cut|run|begun|chosen|driven|eaten|fallen|forgotten|gotten|grown|hidden|ridden|risen|spoken|stolen|sworn|torn|worn|woven|broken|frozen|beaten|bitten|drawn|flown|thrown|blown|sung|rung|sunk|drunk|struck|stuck|swung|hung|dug|fed|bred|fled|slid|spun|sprung|strung|stung|wrung|clung|flung|slung|swept|wept|crept|dealt|felt|knelt|leapt|meant|dreamt|burnt|learnt|smelt|spelt|spilt|spoilt)\b/i;

export function analyzeReadability(text: string, paragraphs: string[] = []): ReadabilityResult {
  const sentences = splitSentences(text);
  const words = countWords(text);
  const tokens = text.match(/[A-Za-z]+/g) ?? [];
  const syllables = tokens.reduce((n, w) => n + countSyllables(w), 0);
  const sc = Math.max(1, sentences.length);
  const wc = Math.max(1, words);
  const fre = 206.835 - 1.015 * (wc / sc) - 84.6 * (syllables / wc);
  const fk = 0.39 * (wc / sc) + 11.8 * (syllables / wc) - 15.59;
  const longSentences = sentences.filter((s) => countWords(s) > 25).length;
  const passive = sentences.filter((s) => PASSIVE_RE.test(s)).length;
  const longParagraphs = paragraphs.filter((p) => countWords(p) > 150).length;
  const level =
    fre >= 90 ? "very easy" : fre >= 70 ? "easy" : fre >= 60 ? "standard" : fre >= 50 ? "fairly difficult" : fre >= 30 ? "difficult" : "very difficult";
  return {
    fleschReadingEase: round(fre),
    fleschKincaidGrade: round(fk),
    sentences: sentences.length,
    words,
    syllables,
    avgSentenceLength: round(wc / sc),
    longSentenceRatio: round(longSentences / sc),
    passiveRatio: round(passive / sc),
    longParagraphs,
    level,
  };
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
