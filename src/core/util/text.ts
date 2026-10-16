export function slugify(input: string, maxLength = 80): string {
  const slug = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= maxLength) return slug;
  const cut = slug.slice(0, maxLength);
  return cut.slice(0, cut.lastIndexOf("-") > 20 ? cut.lastIndexOf("-") : maxLength);
}

export function truncateAtWord(text: string, max: number, suffix = "…"): string {
  const clean = normalizeWhitespace(text);
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - suffix.length);
  const idx = cut.lastIndexOf(" ");
  return `${(idx > max * 0.5 ? cut.slice(0, idx) : cut).replace(/[\s,;:.!?-]+$/, "")}${suffix}`;
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function countWords(text: string): number {
  const m = normalizeWhitespace(text).match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return m ? m.length : 0;
}

/** Reading time in whole minutes at ~230 words per minute, minimum 1. */
export function readingTimeMinutes(wordCount: number, wpm = 230): number {
  return Math.max(1, Math.round(wordCount / wpm));
}

export function splitSentences(text: string): string[] {
  return normalizeWhitespace(text)
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'([])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function uniq<T>(items: Iterable<T>): T[] {
  return [...new Set(items)];
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function isQuestion(text: string): boolean {
  const t = text.trim();
  return (
    /\?$/.test(t) ||
    /^(how|what|why|when|where|which|who|can|should|does|do|is|are|will)\b/i.test(t)
  );
}

export function pluralize(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}
