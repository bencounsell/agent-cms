import path from "node:path";
import MiniSearch from "minisearch";
import { type AiProvider, type AiResolution, resolveAi, type SamplingFn } from "./ai/index.ts";
import { type AuditResult, auditEntry } from "./analysis/audit.ts";
import { type DuplicateReport, findDuplicates } from "./analysis/duplicates.ts";
import { KeywordIndex } from "./analysis/keywords.ts";
import { buildLinkGraph, entryKey, type LinkGraph } from "./analysis/links.ts";
import { auditPage, type PageAuditResult, withPageChecks } from "./analysis/page-audit.ts";
import { type BuildManifest, buildSite } from "./build/index.ts";
import {
  CACHE_DIRNAME,
  type CmsConfig,
  CmsConfigSchema,
  findProjectRoot,
  loadConfig,
  saveConfig,
} from "./config/index.ts";
import {
  type Entry,
  type EntryInput,
  type MetadataField,
  type Status,
  StatusSchema,
} from "./content/schema.ts";
import { ContentStore, type ListOptions, type ValidationIssue } from "./content/store.ts";
import {
  type Briefing,
  buildBriefing,
  buildImprovementPlan,
  type ImprovementPlan,
  refineSuggestionsWithAi,
  type Suggestion,
  suggestDeterministic,
} from "./insights/index.ts";
import { analyzeMarkdown, type MarkdownAnalysis } from "./markdown/analyze.ts";
import {
  type AiMetadata,
  AiMetadataSchema,
  applyAiMetadata,
  type EnrichOptions,
  type EnrichResult,
  enrichEntry,
} from "./metadata/index.ts";
import {
  makeSelfContained,
  type ScreenshotResult,
  screenshotHtml,
  VIEWPORTS,
  type ViewportName,
} from "./preview/index.ts";
import {
  type ComparisonReport,
  type CompetitorRecord,
  compareCompetitors,
  crawlSite,
  ResearchStore,
  type SiteSnapshot,
} from "./research/index.ts";
import {
  buildSiteModel,
  collectAssets,
  type PlannedRoute,
  planRoutes,
  type Route,
  renderRoute,
  routeSummary,
  type SiteModel,
  TemplateStore,
  ThemeStore,
} from "./templates/index.ts";
import { nowIso } from "./util/dates.ts";
import { CmsError } from "./util/errors.ts";
import { readJsonIfExists, sha256, writeJson } from "./util/fs.ts";
import { log } from "./util/log.ts";
import { uniq } from "./util/text.ts";

export interface CmsOptions {
  root?: string;
  cwd?: string;
  sampling?: SamplingFn;
  aiProvider?: AiProvider;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

export interface CorpusContext {
  entries: Entry[];
  analyses: Map<string, MarkdownAnalysis>;
  index: KeywordIndex;
  linkGraph: LinkGraph;
  duplicates: DuplicateReport;
  existingTags: string[];
}

export interface SearchHit {
  collection: string;
  slug: string;
  title: string;
  url: string;
  status: string;
  description?: string;
  score: number;
}

export interface MutationResult {
  entry: Entry;
  enrichment?: EnrichResult;
  audit?: AuditResult;
  nextActions: { action: string; tool: string; args: Record<string, unknown>; reason: string }[];
}

/**
 * The one object every surface (MCP, CLI, HTTP) talks to. Stateless between calls apart from
 * the loaded config and a per-body analysis cache keyed by content hash.
 */
export class Cms {
  readonly root: string;
  readonly cacheDir: string;
  config: CmsConfig;
  readonly store: ContentStore;
  readonly research: ResearchStore;
  readonly theme: ThemeStore;
  ai: AiResolution;
  private readonly opts: CmsOptions;
  private readonly analysisCache = new Map<string, MarkdownAnalysis>();

  private constructor(root: string, config: CmsConfig, opts: CmsOptions) {
    this.root = root;
    this.cacheDir = path.join(root, CACHE_DIRNAME);
    this.config = config;
    this.opts = opts;
    this.store = new ContentStore(root, config);
    this.research = new ResearchStore(this.cacheDir);
    this.theme = new ThemeStore(root);
    this.ai = resolveAi({
      config: config.ai,
      sampling: opts.sampling,
      provider: opts.aiProvider,
      env: opts.env,
    });
  }

  static async open(opts: CmsOptions = {}): Promise<Cms> {
    const root = opts.root ?? (await findProjectRoot(opts.cwd));
    if (!root) {
      throw new CmsError(
        "CONFIG",
        "No agentcms project found. Run `agentcms init` in your site directory first.",
      );
    }
    const config = await loadConfig(root);
    return new Cms(root, config, opts);
  }

  async reload(): Promise<void> {
    this.config = await loadConfig(this.root);
    this.store.setConfig(this.config);
    this.ai = resolveAi({
      config: this.config.ai,
      sampling: this.opts.sampling,
      provider: this.opts.aiProvider,
      env: this.opts.env,
    });
  }

  /** Called by the MCP server once the client's capabilities are known. */
  setSampling(sampling: SamplingFn | undefined): void {
    this.opts.sampling = sampling;
    this.ai = resolveAi({
      config: this.config.ai,
      sampling,
      provider: this.opts.aiProvider,
      env: this.opts.env,
    });
  }

  async updateConfig(patch: Record<string, unknown>): Promise<CmsConfig> {
    const merged = deepMerge(structuredClone(this.config) as Record<string, unknown>, patch);
    const parsed = CmsConfigSchema.safeParse(merged);
    if (!parsed.success)
      throw new CmsError("VALIDATION", "Invalid configuration", parsed.error.issues);
    await saveConfig(this.root, parsed.data);
    await this.reload();
    return this.config;
  }

  // ------------------------------------------------------------------ content

  list(collection: string, opts: ListOptions = {}): Promise<Entry[]> {
    return this.store.list(collection, opts);
  }

  get(collection: string, slug: string): Promise<Entry> {
    return this.store.get(collection, slug);
  }

  async create(
    collection: string,
    input: EntryInput & { title: string },
    opts: { enrich?: boolean } = {},
  ): Promise<MutationResult> {
    const entry = await this.store.create(collection, input);
    return this.afterMutation(entry, opts.enrich ?? true);
  }

  async update(
    collection: string,
    slug: string,
    patch: EntryInput,
    opts: { enrich?: boolean } = {},
  ): Promise<MutationResult> {
    const entry = await this.store.update(collection, slug, patch);
    const bodyChanged = patch.body !== undefined;
    return this.afterMutation(entry, (opts.enrich ?? bodyChanged) || patch.title !== undefined);
  }

  async delete(collection: string, slug: string): Promise<{ deleted: string }> {
    return this.store.delete(collection, slug);
  }

  async setStatus(
    collection: string,
    slug: string,
    status: Status,
    opts: { force?: boolean } = {},
  ): Promise<MutationResult & { blocked?: string }> {
    StatusSchema.parse(status);
    const entry = await this.store.get(collection, slug);
    if (status === "published" && !opts.force) {
      const audit = await this.audit(collection, slug);
      if (!audit.publishable) {
        return {
          entry,
          audit,
          blocked: `Audit score ${audit.scores.overall} is below the publish threshold (${this.config.seo.minAuditScoreToPublish})${audit.failed.some((c) => c.severity === "error") ? " and there are errors" : ""}. Fix the issues or pass force: true.`,
          nextActions: [
            {
              action: "Improve before publishing",
              tool: "improve_content",
              args: { collection, slug },
              reason: audit.failed[0]?.message ?? "",
            },
          ],
        };
      }
    }
    const updated = await this.store.update(collection, slug, { status });
    const nextActions: MutationResult["nextActions"] = [];
    if (status === "published")
      nextActions.push({
        action: "Rebuild static output",
        tool: "build_site",
        args: {},
        reason: "a new entry was published",
      });
    return { entry: updated, nextActions };
  }

  async validate(): Promise<ValidationIssue[]> {
    return this.store.validate();
  }

  async search(
    query: string,
    opts: { collection?: string; limit?: number; status?: Status } = {},
  ): Promise<SearchHit[]> {
    const entries = opts.collection
      ? await this.store.list(opts.collection)
      : await this.store.all();
    const ms = new MiniSearch({
      fields: ["title", "description", "text", "tags"],
      storeFields: ["collection", "slug", "title", "url", "status", "description"],
      searchOptions: { boost: { title: 3 }, prefix: true, fuzzy: 0.2 },
    });
    ms.addAll(
      entries
        .filter((e) => !opts.status || e.frontmatter.status === opts.status)
        .map((e) => ({
          id: entryKey(e),
          collection: e.collection,
          slug: e.slug,
          title: e.frontmatter.title,
          url: e.url,
          status: e.frontmatter.status,
          description: e.frontmatter.description,
          text: this.analysis(e).text,
          tags: e.frontmatter.tags.join(" "),
        })),
    );
    return ms
      .search(query)
      .slice(0, opts.limit ?? 10)
      .map((r) => ({
        collection: r.collection,
        slug: r.slug,
        title: r.title,
        url: r.url,
        status: r.status,
        description: r.description,
        score: Math.round(r.score * 100) / 100,
      }));
  }

  // ------------------------------------------------------------------ analysis

  analysis(entry: Entry): MarkdownAnalysis {
    const h = sha256(`${this.config.site.url}\n${entry.body}`);
    let a = this.analysisCache.get(h);
    if (!a) {
      a = analyzeMarkdown(entry.body, { siteUrl: this.config.site.url });
      if (this.analysisCache.size > 2000) this.analysisCache.clear();
      this.analysisCache.set(h, a);
    }
    return a;
  }

  async corpus(): Promise<CorpusContext> {
    const entries = await this.store.all();
    const analyses = new Map<string, MarkdownAnalysis>();
    for (const e of entries) analyses.set(entryKey(e), this.analysis(e));
    const index = new KeywordIndex(
      entries.map((e) => ({
        id: entryKey(e),
        title: e.frontmatter.title,
        headings: analyses.get(entryKey(e))!.headings.map((h) => h.text),
        text: analyses.get(entryKey(e))!.text,
      })),
    );
    const linkGraph = buildLinkGraph(entries, analyses, this.config.site.url);
    const duplicates = findDuplicates(entries);
    const existingTags = uniq(entries.flatMap((e) => e.frontmatter.tags));
    return { entries, analyses, index, linkGraph, duplicates, existingTags };
  }

  async enrich(collection: string, slug: string, opts: EnrichOptions = {}): Promise<EnrichResult> {
    const entry = await this.store.get(collection, slug);
    const corpus = await this.corpus();
    return this.enrichWithCorpus(entry, corpus, opts);
  }

  private async enrichWithCorpus(
    entry: Entry,
    corpus: CorpusContext,
    opts: EnrichOptions,
  ): Promise<EnrichResult> {
    const collectionConfig = this.store.collection(entry.collection);
    const author = entry.frontmatter.author
      ? corpus.entries.find(
          (e) =>
            e.slug === entry.frontmatter.author &&
            this.store.collection(e.collection).kind === "author",
        )
      : undefined;
    return enrichEntry(
      entry,
      this.analysis(entry),
      {
        config: this.config,
        collection: collectionConfig,
        corpus: corpus.entries,
        analyses: corpus.analyses,
        index: corpus.index,
        author,
        store: this.store,
        ai: this.ai,
        existingTags: corpus.existingTags,
      },
      opts,
    );
  }

  async enrichAll(
    opts: EnrichOptions & { collection?: string; status?: Status } = {},
  ): Promise<EnrichResult[]> {
    const corpus = await this.corpus();
    const targets = corpus.entries.filter(
      (e) =>
        (!opts.collection || e.collection === opts.collection) &&
        (!opts.status || e.frontmatter.status === opts.status),
    );
    const out: EnrichResult[] = [];
    for (const e of targets) out.push(await this.enrichWithCorpus(e, corpus, opts));
    return out;
  }

  /** Apply metadata produced by the calling agent (delegate mode). */
  async submitMetadata(
    collection: string,
    slug: string,
    metadata: unknown,
    fields?: MetadataField[],
  ): Promise<EnrichResult> {
    const parsed = AiMetadataSchema.safeParse(metadata);
    if (!parsed.success)
      throw new CmsError(
        "VALIDATION",
        "Submitted metadata does not match the schema",
        parsed.error.issues,
      );
    const entry = await this.store.get(collection, slug);
    const collectionConfig = this.store.collection(collection);
    const requested = new Set<MetadataField>(
      fields ?? (collectionConfig.metadata.auto as MetadataField[]),
    );
    const applied = applyAiMetadata(
      entry.frontmatter,
      parsed.data as AiMetadata,
      requested,
      this.config,
      collectionConfig,
    );
    const fm = applied.frontmatter;
    const previousReview = (entry.frontmatter.review ?? []).filter(
      (r) => !applied.resolvedReview.includes(r),
    );
    fm.review = uniq([...previousReview, ...applied.review]);
    if (fm.review.length === 0) fm.review = undefined;
    fm.generated = {
      fields: uniq([...(entry.frontmatter.generated?.fields ?? []), ...requested]),
      provider: "agent+deterministic",
      at: nowIso(),
    };
    const saved = await this.store.save({ ...entry, frontmatter: fm });
    return {
      entry: saved,
      generated: [...requested],
      provider: "agent",
      review: fm.review ?? [],
      notes: applied.notes,
      skipped: [],
    };
  }

  async audit(collection: string, slug: string): Promise<AuditResult> {
    const entry = await this.store.get(collection, slug);
    const corpus = await this.corpus();
    const base = this.auditWithCorpus(entry, corpus);
    if (!this.config.build.html.enabled || entry.frontmatter.status === "archived") return base;
    try {
      const rendered = await this.renderEntry(entry, corpus);
      return rendered ? withPageChecks(base, rendered.audit) : base;
    } catch (err) {
      log.warn("page audit skipped:", err);
      return base;
    }
  }

  private auditWithCorpus(entry: Entry, corpus: CorpusContext): AuditResult {
    return auditEntry(entry, corpus.analyses.get(entryKey(entry)) ?? this.analysis(entry), {
      config: this.config,
      collection: this.store.collection(entry.collection),
      linkGraph: corpus.linkGraph,
      duplicates: corpus.duplicates,
    });
  }

  async auditAll(opts: { collection?: string; status?: Status } = {}): Promise<AuditResult[]> {
    const corpus = await this.corpus();
    return corpus.entries
      .filter(
        (e) =>
          (!opts.collection || e.collection === opts.collection) &&
          (!opts.status || e.frontmatter.status === opts.status),
      )
      .map((e) => this.auditWithCorpus(e, corpus))
      .sort((a, b) => a.scores.overall - b.scores.overall);
  }

  async improve(collection: string, slug: string): Promise<ImprovementPlan> {
    const entry = await this.store.get(collection, slug);
    const corpus = await this.corpus();
    const audit = this.auditWithCorpus(entry, corpus);
    return buildImprovementPlan({
      config: this.config,
      entry,
      analysis: corpus.analyses.get(entryKey(entry))!,
      audit,
      entries: corpus.entries,
      linkGraph: corpus.linkGraph,
      competitors: await this.research.list(),
    });
  }

  // ------------------------------------------------------------------ insights

  async briefing(): Promise<Briefing> {
    const corpus = await this.corpus();
    const audits = new Map(
      corpus.entries.map((e) => [entryKey(e), this.auditWithCorpus(e, corpus)]),
    );
    const briefing = buildBriefing({
      config: this.config,
      entries: corpus.entries,
      audits,
      linkGraph: corpus.linkGraph,
      validation: await this.validate(),
      competitors: await this.research.list(),
      ai: this.ai,
    });
    await writeJson(path.join(this.cacheDir, "last-briefing.json"), { at: briefing.generatedAt });
    return briefing;
  }

  async suggest(
    opts: { limit?: number; focus?: string; useAi?: boolean } = {},
  ): Promise<Suggestion[]> {
    const corpus = await this.corpus();
    const audits = new Map(
      corpus.entries.map((e) => [entryKey(e), this.auditWithCorpus(e, corpus)]),
    );
    const competitors = await this.research.list();
    const comparison = competitors.some((c) => c.latest)
      ? compareCompetitors({
          config: this.config,
          entries: corpus.entries,
          analyses: corpus.analyses,
          competitors,
        })
      : undefined;
    const input = {
      config: this.config,
      entries: corpus.entries,
      analyses: corpus.analyses,
      audits,
      linkGraph: corpus.linkGraph,
      competitors,
      comparison,
      ai: this.ai,
      limit: opts.limit,
      focus: opts.focus,
    };
    const base = suggestDeterministic(input);
    return opts.useAi === false ? base : refineSuggestionsWithAi(input, base);
  }

  // ------------------------------------------------------------------ research

  async addCompetitor(
    url: string,
    meta: { name?: string; notes?: string } = {},
  ): Promise<CompetitorRecord> {
    const normalized = new URL(url).toString();
    const rec = await this.research.add(normalized, meta);
    if (!this.config.research.competitors.some((c) => new URL(c.url).host === rec.host)) {
      await this.updateConfig({
        research: {
          competitors: [
            ...this.config.research.competitors,
            { url: normalized, name: meta.name, notes: meta.notes, addedAt: nowIso() },
          ],
        },
      });
    }
    return rec;
  }

  async removeCompetitor(host: string): Promise<void> {
    await this.research.remove(host);
    await this.updateConfig({
      research: {
        competitors: this.config.research.competitors.filter((c) => new URL(c.url).host !== host),
      },
    });
  }

  async refreshCompetitor(
    host: string,
    opts: { maxPages?: number; onProgress?: (m: string) => void } = {},
  ): Promise<{ record: CompetitorRecord; snapshot: SiteSnapshot }> {
    const rec = await this.research.require(host);
    const snapshot = await crawlSite({
      url: rec.url,
      config: this.config.research,
      fetchImpl: this.opts.fetchImpl,
      maxPages: opts.maxPages,
      onProgress: opts.onProgress,
    });
    const record = await this.research.saveSnapshot(host, snapshot);
    return { record, snapshot };
  }

  async refreshAllCompetitors(
    opts: { maxPages?: number; onProgress?: (m: string) => void; onlyStale?: boolean } = {},
  ): Promise<{ host: string; pages: number; newPages: number; errors: string[] }[]> {
    const out: { host: string; pages: number; newPages: number; errors: string[] }[] = [];
    for (const rec of await this.research.list()) {
      if (
        opts.onlyStale &&
        rec.latest &&
        Date.now() - new Date(rec.latest.fetchedAt).getTime() <
          this.config.research.refreshAfterDays * 86_400_000
      )
        continue;
      try {
        const { record, snapshot } = await this.refreshCompetitor(rec.host, opts);
        out.push({
          host: rec.host,
          pages: snapshot.pages.length,
          newPages: record.history[record.history.length - 1]?.newPages.length ?? 0,
          errors: snapshot.errors,
        });
      } catch (err) {
        out.push({ host: rec.host, pages: 0, newPages: 0, errors: [(err as Error).message] });
      }
    }
    return out;
  }

  async compare(): Promise<ComparisonReport> {
    const corpus = await this.corpus();
    const competitors = await this.research.list();
    if (competitors.length === 0)
      throw new CmsError(
        "NOT_FOUND",
        "No competitors tracked. Call add_competitor with a URL first, then research_competitors.",
      );
    if (!competitors.some((c) => c.latest))
      throw new CmsError(
        "VALIDATION",
        "Competitors have not been crawled yet. Call research_competitors first.",
      );
    const report = compareCompetitors({
      config: this.config,
      entries: corpus.entries,
      analyses: corpus.analyses,
      competitors,
    });
    await writeJson(path.join(this.cacheDir, "last-comparison.json"), report);
    return report;
  }

  async lastComparison(): Promise<ComparisonReport | undefined> {
    return readJsonIfExists<ComparisonReport>(path.join(this.cacheDir, "last-comparison.json"));
  }

  // ------------------------------------------------------------------ build

  async build(
    opts: { outDir?: string; includeDrafts?: boolean } = {},
  ): Promise<BuildManifest & { pages: number }> {
    const corpus = await this.corpus();
    let pageCount = 0;
    const extra = this.config.build.html.enabled
      ? async (write: (rel: string, content: string | Buffer) => Promise<void>) => {
          const model = await this.siteModel(corpus, opts.includeDrafts);
          const { files, map } = await collectAssets(
            this.templates.dir,
            this.config.build.html.assetsPath,
          );
          for (const f of files) await write(f.rel, f.content);
          const engine = this.templates.engine();
          for (const route of await planRoutes(model, this.templates.roots)) {
            await write(route.file, await renderRoute(engine, model, route, map));
            pageCount++;
          }
        }
      : undefined;
    const manifest = await buildSite({
      root: this.root,
      config: this.config,
      entries: corpus.entries,
      analyses: corpus.analyses,
      outDir: opts.outDir,
      includeDrafts: opts.includeDrafts,
      extra,
    });
    return { ...manifest, pages: pageCount };
  }

  // ------------------------------------------------------------------ templates & pages

  get templates(): TemplateStore {
    return new TemplateStore(this.root, this.config);
  }

  async siteModel(corpus?: CorpusContext, includeDrafts?: boolean): Promise<SiteModel> {
    const c = corpus ?? (await this.corpus());
    return buildSiteModel({
      config: this.config,
      entries: c.entries,
      analyses: c.analyses,
      theme: await this.theme.resolve(),
      includeDrafts,
    });
  }

  async routes(opts: { includeDrafts?: boolean } = {}): Promise<Route[]> {
    const model = await this.siteModel(undefined, opts.includeDrafts);
    return (await planRoutes(model, this.templates.roots)).map(routeSummary);
  }

  private async renderPlanned(
    model: SiteModel,
    route: PlannedRoute,
    knownPaths: Set<string>,
  ): Promise<{
    html: string;
    audit: PageAuditResult;
    assets: Awaited<ReturnType<typeof collectAssets>>;
  }> {
    const assets = await collectAssets(this.templates.dir, this.config.build.html.assetsPath);
    const html = await renderRoute(this.templates.engine(), model, route, assets.map);
    const ctx = route.context();
    const audit = auditPage({
      html,
      path: route.path,
      url: ctx.page.url,
      expected: {
        title: ctx.head.title,
        description: ctx.head.description,
        canonical: ctx.head.canonical ?? ctx.page.url,
        noindex: ctx.head.noindex,
      },
      knownPaths,
      assetPrefixes: [
        `${this.config.build.html.assetsPath.replace(/\/+$/, "")}/`,
        `/${this.config.build.dataPath.replace(/^\/+|\/+$/g, "")}/`,
        "/feeds/",
      ],
    });
    return { html, audit, assets };
  }

  private async renderEntry(
    entry: Entry,
    corpus: CorpusContext,
  ): Promise<{ html: string; audit: PageAuditResult } | undefined> {
    const model = await this.siteModel(corpus, true);
    const routes = await planRoutes(model, this.templates.roots);
    const route = routes.find(
      (r) => r.entry?.collection === entry.collection && r.entry.slug === entry.slug,
    );
    if (!route) return undefined;
    const known = new Set(routes.map((r) => r.path));
    const { html, audit } = await this.renderPlanned(model, route, known);
    return { html, audit };
  }

  /** Render one route (by path, or by entry) without writing anything. */
  async preview(
    target: { path?: string; collection?: string; slug?: string },
    opts: { screenshots?: ViewportName[]; selfContained?: boolean } = {},
  ): Promise<{
    route: Route;
    html: string;
    audit: PageAuditResult;
    screenshots: { viewport: ViewportName; result: ScreenshotResult }[];
  }> {
    const model = await this.siteModel(undefined, true);
    const routes = await planRoutes(model, this.templates.roots);
    const route = target.path
      ? routes.find(
          (r) => r.path === target.path || r.path === `${target.path!.replace(/\/+$/, "")}/`,
        )
      : routes.find(
          (r) => r.entry?.collection === target.collection && r.entry?.slug === target.slug,
        );
    if (!route)
      throw new CmsError(
        "NOT_FOUND",
        `No page for ${target.path ?? `${target.collection}/${target.slug}`}. Call list_routes to see what the site renders.`,
      );
    const known = new Set(routes.map((r) => r.path));
    const { html, audit, assets } = await this.renderPlanned(model, route, known);
    const document =
      opts.selfContained === false
        ? html
        : makeSelfContained(html, {
            siteUrl: this.config.site.url,
            assets: assets.files,
            assetMap: assets.map,
          });
    const screenshots: { viewport: ViewportName; result: ScreenshotResult }[] = [];
    for (const viewport of opts.screenshots ?? []) {
      screenshots.push({ viewport, result: await screenshotHtml(document, VIEWPORTS[viewport]) });
    }
    return { route: routeSummary(route), html: document, audit, screenshots };
  }

  /** Audit every rendered route. */
  async auditPages(opts: { includeDrafts?: boolean } = {}): Promise<PageAuditResult[]> {
    const model = await this.siteModel(undefined, opts.includeDrafts);
    const routes = await planRoutes(model, this.templates.roots);
    const known = new Set(routes.map((r) => r.path));
    const out: PageAuditResult[] = [];
    for (const route of routes) out.push((await this.renderPlanned(model, route, known)).audit);
    return out.sort((a, b) => a.score - b.score);
  }

  // ------------------------------------------------------------------ helpers

  private async afterMutation(entry: Entry, enrich: boolean): Promise<MutationResult> {
    let current = entry;
    let enrichment: EnrichResult | undefined;
    const nextActions: MutationResult["nextActions"] = [];
    if (enrich) {
      const corpus = await this.corpus();
      enrichment = await this.enrichWithCorpus(current, corpus, {});
      current = enrichment.entry;
      if (enrichment.delegated) {
        nextActions.push({
          action: "Generate the model-quality metadata yourself and submit it",
          tool: "submit_metadata",
          args: { collection: current.collection, slug: current.slug },
          reason: enrichment.delegated.reason,
        });
      }
      if (enrichment.review.length) {
        nextActions.push({
          action: `Confirm generated fields: ${enrichment.review.join(", ")}`,
          tool: "update_content",
          args: { collection: current.collection, slug: current.slug },
          reason: "auto-generated values flagged for review",
        });
      }
    }
    const audit = await this.audit(current.collection, current.slug);
    if (!audit.publishable) {
      nextActions.push({
        action: `Fix the top audit issues before publishing (score ${audit.scores.overall})`,
        tool: "improve_content",
        args: { collection: current.collection, slug: current.slug },
        reason: audit.failed[0]?.message ?? "",
      });
    } else if (current.frontmatter.status !== "published") {
      nextActions.push({
        action: "Ready to publish when the human agrees",
        tool: "set_status",
        args: { collection: current.collection, slug: current.slug, status: "published" },
        reason: `audit score ${audit.scores.overall}`,
      });
    }
    return { entry: current, enrichment, audit, nextActions };
  }
}

function deepMerge(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  for (const [k, v] of Object.entries(patch)) {
    const existing = target[k];
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing)
    ) {
      target[k] = deepMerge(
        { ...(existing as Record<string, unknown>) },
        v as Record<string, unknown>,
      );
    } else if (v === null) {
      delete target[k];
    } else {
      target[k] = v;
    }
  }
  return target;
}

export { entryKey };
