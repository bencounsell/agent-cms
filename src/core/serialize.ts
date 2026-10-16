import type { Entry } from "./content/schema.ts";

export interface EntrySummary {
  collection: string;
  slug: string;
  title: string;
  status: string;
  url: string;
  path: string;
  file: string;
  publishedAt?: string;
  updatedAt?: string;
  author?: string;
  category?: string;
  tags: string[];
  description?: string;
  readingTime?: number;
  wordCount?: number;
  review?: string[];
}

export function summarizeEntry(e: Entry): EntrySummary {
  const fm = e.frontmatter;
  return {
    collection: e.collection,
    slug: e.slug,
    title: fm.title,
    status: fm.status,
    url: e.url,
    path: e.path,
    file: e.relativePath,
    publishedAt: fm.publishedAt,
    updatedAt: fm.updatedAt,
    author: fm.author,
    category: fm.category,
    tags: fm.tags,
    description: fm.description,
    readingTime: fm.readingTime,
    wordCount: fm.wordCount,
    review: fm.review,
  };
}

export function serializeEntry(
  e: Entry,
  opts: { body?: boolean } = {},
): EntrySummary & { frontmatter: Record<string, unknown>; body?: string } {
  return {
    ...summarizeEntry(e),
    frontmatter: e.frontmatter as Record<string, unknown>,
    ...(opts.body === false ? {} : { body: e.body }),
  };
}
