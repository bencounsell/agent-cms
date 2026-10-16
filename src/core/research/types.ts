export interface PageRecord {
  url: string;
  path: string;
  title?: string;
  description?: string;
  h1?: string;
  h2: string[];
  h3: string[];
  wordCount: number;
  publishedAt?: string;
  modifiedAt?: string;
  author?: string;
  schemaTypes: string[];
  hasFaq: boolean;
  questionHeadings: number;
  ogImage?: string;
  canonical?: string;
  lang?: string;
  internalLinks: number;
  externalLinks: number;
  images: number;
  keywords: string[];
  fetchedAt: string;
}

export interface SiteSnapshot {
  host: string;
  url: string;
  name?: string;
  fetchedAt: string;
  sitemapUrls: string[];
  discovered: number;
  pages: PageRecord[];
  errors: string[];
}

export interface SnapshotHistoryItem {
  fetchedAt: string;
  pageCount: number;
  newPages: { url: string; title?: string }[];
}

export interface CompetitorRecord {
  host: string;
  url: string;
  name?: string;
  notes?: string;
  addedAt: string;
  history: SnapshotHistoryItem[];
  latest?: SiteSnapshot;
}

export interface CompetitorSummary {
  host: string;
  name?: string;
  url: string;
  pages: number;
  cadencePerMonth: number;
  avgWordCount: number;
  faqShare: number;
  schemaShare: number;
  questionHeadingShare: number;
  lastFetched?: string;
  recent: { url: string; title?: string; publishedAt?: string }[];
  topTopics: string[];
}

export interface TopicGap {
  topic: string;
  score: number;
  competitorPages: { host: string; url: string; title?: string }[];
  ourCoverage: number;
}

export interface Opportunity {
  type: "new_topic" | "structure" | "cadence" | "depth" | "schema" | "freshness" | "questions";
  title: string;
  reason: string;
  evidence: string[];
  targetKeywords: string[];
  priority: 1 | 2 | 3;
}

export interface ComparisonReport {
  generatedAt: string;
  ours: Omit<CompetitorSummary, "host" | "url" | "name" | "lastFetched">;
  competitors: CompetitorSummary[];
  gaps: TopicGap[];
  opportunities: Opportunity[];
  strengths: string[];
  weaknesses: string[];
  summary: string;
}
