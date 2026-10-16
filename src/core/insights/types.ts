export interface NextAction {
  priority: 1 | 2 | 3;
  action: string;
  tool: string;
  args: Record<string, unknown>;
  reason: string;
}

export interface EntryRef {
  collection: string;
  slug: string;
  title: string;
  url: string;
  status: string;
}

export interface Briefing {
  generatedAt: string;
  headline: string;
  site: { name: string; url: string };
  counts: {
    total: number;
    byCollection: { name: string; kind: string; total: number; byStatus: Record<string, number> }[];
  };
  drafts: (EntryRef & { ageDays: number; auditScore?: number })[];
  inReview: (EntryRef & { review: string[] })[];
  stale: (EntryRef & { ageDays: number })[];
  weakMetadata: (EntryRef & { missing: string[] })[];
  lowScores: (EntryRef & { overall: number; topIssue: string })[];
  orphans: EntryRef[];
  brokenLinks: { from: string; url: string }[];
  validation: { errors: number; warnings: number; sample: string[] };
  research: {
    competitors: number;
    lastRefresh?: string;
    refreshDue: boolean;
    newPages: { host: string; count: number; titles: string[] }[];
  };
  ai: { mode: string; provider?: string; reason?: string };
  nextActions: NextAction[];
}

export interface Suggestion {
  id: string;
  type: "new" | "refresh" | "expand" | "link" | "series" | "structure";
  title: string;
  rationale: string;
  evidence: string[];
  targetKeywords: string[];
  outline?: string[];
  relatedEntries?: string[];
  effort: "small" | "medium" | "large";
  score: number;
  action?: NextAction;
}

export interface ImprovementStep {
  priority: 1 | 2 | 3;
  area: string;
  action: string;
  detail: string;
  evidence?: unknown;
}

export interface ImprovementPlan {
  collection: string;
  slug: string;
  title: string;
  url: string;
  scores: Record<string, number>;
  publishable: boolean;
  steps: ImprovementStep[];
  linkCandidates: {
    collection: string;
    slug: string;
    title: string;
    url: string;
    reason: string;
  }[];
  faqCandidates: string[];
  questionCandidates: string[];
  competitorBenchmarks: {
    host: string;
    url: string;
    title?: string;
    wordCount: number;
    hasFaq: boolean;
  }[];
  summary: string;
}
