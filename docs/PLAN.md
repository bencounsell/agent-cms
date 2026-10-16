# agentcms — implementation plan

> An agent-first, headless CMS. No admin UI. Content lives as files in git, every operation is a
> tool for an AI agent (MCP), a CLI command, or an HTTP API call, and the only thing it ever
> produces is static files.

This document is the plan the implementation follows. It is kept in the repository so that agents
and humans working on the project share the same picture. Sections marked **(status)** are updated
as phases land.

---

## 1. Product definition

### What it is

- A **content repository** on disk: Markdown + YAML frontmatter, one file per entry, grouped into
  collections (`content/posts/*.md`, `content/pages/*.md`, …). Git is the history, review and
  backup system.
- A **metadata engine** that fills in everything a piece of content needs to be published well:
  slug, description, excerpt, category, tags, keywords, reading time, Open Graph and Twitter
  card data, JSON-LD structured data, and answer-engine (AEO) blocks such as a direct answer,
  key takeaways and FAQ pairs.
- An **analysis engine**: SEO audit, AEO audit, readability, internal-link graph, freshness,
  duplicate detection, content-gap analysis against competitors.
- A **research engine** that crawls competitor sites politely, records what they publish, how
  often, how long, with which structure, and turns that into "what they do well" and "what we
  should do next".
- A **static builder** that emits a JSON content API, feeds, sitemap, `llms.txt`, search index and
  structured data into an output directory for any static site generator or front end to consume.
- Three surfaces over one core:
  - **MCP server** (stdio for local agents, Streamable HTTP for remote agents) with tools,
    resources, prompts and server instructions that tell the agent how to work.
  - **CLI** (`agentcms …`) for humans, scripts and CI.
  - **HTTP API** with an OpenAPI 3.1 document so any AI app or automation can call it.

### What it is not

- No web admin, no editor UI, no dashboard. Humans use their agent (Claude Code, Claude Desktop,
  Cursor, …) or the CLI.
- No database, no runtime server needed to serve the published site. Output is static.
- No site renderer. It produces data (JSON, HTML fragments, feeds), the user's site renders it.

### Proactive by design

The CMS does not wait to be asked. It:

- Greets every agent session with a **briefing** (what changed, what is stale, what is missing,
  what competitors published, what to do next) and ships that same advice in the server
  instructions so the agent runs it first.
- Returns **next actions** with every mutating tool result (for example: "metadata generated,
  two fields flagged for review, run `audit_content` before publishing").
- Generates metadata automatically on create and update, and marks each generated field with
  provenance so humans and agents know what was machine-written.
- Keeps a **suggestions queue**: topics to write, posts to refresh, links to add, structure to
  improve, with evidence for each suggestion.

---

## 2. Technology choices

| Concern | Choice | Why |
| --- | --- | --- |
| Runtime | Node.js ≥ 22, ESM only | Built-in `fetch`, type stripping, stable LTS. |
| Language | TypeScript 7 (native compiler), `erasableSyntaxOnly`, `.ts` import specifiers rewritten on emit | Source runs directly under Node in development, compiles for publishing. |
| Schemas | Zod 4 | One schema per concept, reused for config validation, frontmatter, MCP tool input/output and OpenAPI. |
| MCP | `@modelcontextprotocol/sdk` 1.32 | Official SDK, structured tool output, annotations, resources, prompts, sampling, stdio + Streamable HTTP. |
| HTTP API | Hono 4 + `@hono/zod-openapi` + `@hono/node-server`, MCP mounted at `/mcp` via `@hono/mcp` | One process serves REST, OpenAPI and remote MCP. Runs on Node, Bun, Deno, Workers. |
| CLI | commander 15 | Mature, small, good help output. |
| Markdown | unified / remark / rehype | Standard AST (mdast) for analysis, GFM support, HTML output. |
| Frontmatter | `yaml` 2 | Spec-compliant parser and serialiser, preserves field order. |
| Research | `fetch` + cheerio + `fast-xml-parser` | Sitemap discovery and HTML extraction with no browser. |
| Search index | MiniSearch | Serialisable static index, loadable in any front end. |
| AI | `@anthropic-ai/sdk` (model `claude-opus-5-5` by default), MCP sampling, or delegation to the calling agent | Works with no key at all, better with one. |
| Tests | Vitest | Fast, TypeScript-native. |
| Lint / format | Biome 2 | One tool, no config sprawl. |

Package name: **`agentcms`** (binary `agentcms`). `agent-cms` on npm belongs to an unrelated
project, so the repository keeps its name and the package uses the unhyphenated form.

---

## 3. Repository layout

```
agent-cms/
├── bin/agentcms.js            # executable shim -> dist/cli/main.js
├── src/
│   ├── index.ts               # public library API (createCms, types)
│   ├── cli/                   # commander commands, one file per command group
│   ├── mcp/                   # MCP server: tools, resources, prompts, instructions
│   ├── api/                   # Hono app, OpenAPI routes, auth, MCP mount
│   └── core/
│       ├── config/            # config schema, loader, defaults, writer
│       ├── content/           # store (CRUD over files), frontmatter, slugs, ids, collections
│       ├── markdown/          # parse, render, outline, links, images, text extraction
│       ├── metadata/          # deterministic enrichers + AI enrichers + provenance
│       ├── ai/                # provider abstraction: anthropic | sampling | delegate | none
│       ├── analysis/          # keywords, readability, seo audit, aeo audit, link graph, duplicates
│       ├── research/          # robots, sitemap discovery, page extraction, competitor store, comparison
│       ├── insights/          # briefing, suggestions, next-actions
│       ├── build/             # static outputs: json api, feeds, sitemap, llms.txt, search, jsonld
│       └── util/              # fs, dates, text, logging
├── templates/                 # files written by `agentcms init`
├── docs/                      # PLAN, INSTALL, AGENT-GUIDE, API, CONTENT-MODEL, SEO-AEO
├── test/                      # vitest suites + fixtures
└── README.md                  # install docs and first steps
```

---

## 4. Content model

### Project files (created by `agentcms init`)

```
my-site/
├── agentcms.config.json       # site, collections, taxonomy, ai, research, build
├── AGENTS.md                  # tells any agent that this project uses agentcms and how
├── content/
│   ├── posts/2026-10-16-hello-world.md
│   ├── pages/about.md
│   └── authors/ben.md
├── .agentcms/                 # cache: research snapshots, audit history, build manifest
└── public/cms/ (or dist/cms)  # build output, consumed by the site
```

### Config (`agentcms.config.json`)

- `site`: `name`, `url`, `description`, `language`, `organization`, `defaultAuthor`,
  `socialProfiles`.
- `collections[]`: `name`, `kind` (`post` | `page` | `doc` | `author` | `custom`), `path`,
  `urlPattern` (`/blog/{slug}`), `fields` (extra typed fields), `metadata` (which auto fields to
  generate, taxonomy constraints), `sort`.
- `taxonomy`: `categories[]` (fixed list, optional), `tagPolicy` (`open` | `closed`, max tags).
- `ai`: `provider` (`auto` | `anthropic` | `sampling` | `delegate` | `none`), `model`, `effort`.
- `research`: `competitors[]` (`url`, `name`, `notes`), `maxPagesPerSite`, `userAgent`,
  `refreshAfterDays`.
- `seo`: `targetWordCount`, `titleLength`, `descriptionLength`, `staleAfterDays`,
  `minInternalLinks`.
- `build`: `outDir`, `baseUrl`, `feeds`, `llmsTxt`, `searchIndex`.

### Entry frontmatter (all collections share the core, kinds add fields)

```yaml
id: 0b7d4e6e-...                # uuid, stable across renames
title: Why agent-first CMSs win
slug: why-agent-first-cmss-win
status: draft | review | published | archived
publishedAt: 2026-10-16T09:00:00Z
updatedAt: 2026-10-16T09:00:00Z
author: ben
category: Engineering
tags: [cms, mcp, ai-agents]
keywords: [agent-first cms, mcp cms]
description: 150-char SEO description
excerpt: Short plain-text teaser
image: /images/agent-first.png
imageAlt: ...
canonical: https://...
language: en
seo: { title, description, noindex }
social:
  og: { title, description, image, type }
  twitter: { card, title, description, image }
aeo:
  answer: One-paragraph direct answer to the question the post addresses
  keyTakeaways: [..]
  faq: [{ question, answer }]
  questions: [..]                 # search questions this post should rank for
schema: { "@type": BlogPosting, ... }   # override or extend generated JSON-LD
readingTime: 6
wordCount: 1340
generated:                        # provenance for auto-filled fields
  fields: [description, tags, keywords, social, aeo]
  provider: anthropic | deterministic | sampling | agent
  at: 2026-10-16T09:00:00Z
review: [category]                # fields a human or agent should confirm
```

The CMS never overwrites a field a human set unless asked. Generated fields are tracked in
`generated.fields`; regenerating only touches those (or an explicit field list).

---

## 5. Surfaces

### 5.1 MCP server

Transport: `agentcms mcp` (stdio) and `agentcms serve` (Streamable HTTP at `/mcp`).

**Instructions** (sent on initialise): what the CMS is, the workflow
(briefing → draft → enrich → audit → publish → build), conventions (slugs, statuses, taxonomy,
provenance), the rule that the agent proposes and the human decides on publishing and deleting,
and how to handle "delegate" AI tasks (the agent generates the metadata itself and submits it).

**Tools** (snake_case, Zod input and output schemas, annotations):

| Tool | Purpose | Hints |
| --- | --- | --- |
| `get_briefing` | Proactive session start: stats, stale, missing metadata, drafts, competitor deltas, next actions | read-only |
| `list_content`, `get_content`, `search_content` | Read content | read-only |
| `create_content` | Create entry, auto-enrich, return next actions | |
| `update_content` | Patch frontmatter and/or body, re-enrich changed areas | idempotent |
| `set_status` | draft → review → published → archived with audit gate | |
| `delete_content` | Remove entry | destructive |
| `enrich_metadata` | (Re)generate metadata for one or all entries, optional field list | |
| `audit_content` | SEO + AEO + readability audit, scored, with concrete fixes | read-only |
| `improve_content` | Improvement plan for an entry: structure, answer-first lead, links, FAQ | read-only |
| `suggest_content` | New topics, refreshes, expansions, with evidence | read-only |
| `add_competitor`, `list_competitors`, `research_competitor`, `compare_competitors` | Competitor research and gap analysis | network |
| `validate_content` | Check all files against schemas | read-only |
| `build_site` | Write static outputs | |
| `get_config`, `update_config` | Read / patch configuration | |

**Resources**: `agentcms://guide`, `agentcms://config`, `agentcms://briefing`,
`agentcms://content/{collection}/{slug}`, `agentcms://schema/{collection}`.

**Prompts**: `write_post`, `improve_post`, `seo_audit`, `aeo_optimize`, `competitor_brief`,
`content_calendar`.

### 5.2 CLI

```
agentcms init [--client claude-code|claude-desktop|cursor|codex]
agentcms mcp                       # stdio MCP server
agentcms serve [--port 4321]       # HTTP API + OpenAPI + MCP over HTTP
agentcms briefing
agentcms content list|get|create|update|delete|publish
agentcms enrich [slug|--all] [--fields …]
agentcms audit  [slug|--all] [--json]
agentcms suggest
agentcms research add|list|refresh|compare
agentcms build
agentcms validate
agentcms doctor                    # environment + config + AI provider check
agentcms guide                     # print the agent guide
```

### 5.3 HTTP API

`agentcms serve` exposes:

- `GET /openapi.json` (OpenAPI 3.1), `GET /health`
- `GET|POST /v1/content/{collection}`, `GET|PATCH|DELETE /v1/content/{collection}/{slug}`
- `POST /v1/content/{collection}/{slug}/enrich|audit|status`
- `GET /v1/search?q=`
- `GET /v1/briefing`, `GET /v1/suggestions`
- `GET|POST /v1/competitors`, `POST /v1/competitors/{host}/refresh`, `GET /v1/competitors/compare`
- `POST /v1/build`, `GET|PATCH /v1/config`
- `ALL /mcp` (Streamable HTTP MCP)

Auth: bearer token from `AGENTCMS_API_TOKEN`; requests from loopback are allowed without a token
unless `AGENTCMS_REQUIRE_TOKEN=1`.

---

## 6. Engines

### 6.1 Metadata generation (two layers)

1. **Deterministic** (no network, always runs): id, slug, dates, word count, reading time, excerpt,
   description fallback, outline, links, images, keywords (TF-IDF across the corpus with title
   boost), category guess (taxonomy keyword overlap), tag candidates (corpus co-occurrence),
   related entries, Open Graph and Twitter defaults, JSON-LD (BlogPosting / Article / WebPage /
   FAQPage / Person / Organization / BreadcrumbList).
2. **AI** (when a provider is available): SEO title and description, category from the taxonomy,
   tags, keywords, social copy, direct answer, key takeaways, FAQ pairs, target questions. The
   request asks for structured JSON validated by the same Zod schema as the frontmatter.

Provider resolution (`ai.provider: auto`): Anthropic API if credentials resolve → MCP sampling if
the client advertises it → delegate (the tool returns a task describing exactly what to generate
and how to submit it) → deterministic only.

### 6.2 Audits

Each check returns `{ id, area, severity, message, fix, evidence }`, scores are 0–100 per area.

- **SEO**: title and description length, single H1, heading hierarchy, focus keyword in title,
  description, first paragraph and slug, image alt text, internal links ≥ N, external links,
  word count vs target, slug quality, canonical, duplicate titles/descriptions across the corpus,
  dates present.
- **AEO**: answer-first lead (direct answer within the first 60 words), question-form headings,
  key takeaways block, FAQ block with FAQPage JSON-LD, definitions for key entities, cited
  sources, author and dateModified (E-E-A-T), `llms.txt` enabled, speakable candidates.
- **Readability**: Flesch Reading Ease, FK grade, long sentences, long paragraphs, passive-voice
  heuristic, jargon density.
- **Freshness and links**: stale entries, orphan entries (no inbound links), broken internal links.

### 6.3 Competitor research

`add_competitor(url)` discovers sitemaps (robots.txt → `Sitemap:` lines → `/sitemap.xml` →
sitemap index), picks the most recent N URLs, fetches them politely (robots rules, one request at
a time, delay, identifiable user agent) and extracts: title, description, H1–H3, word count,
published/modified dates (meta, `article:*`, JSON-LD), schema types, FAQ presence, Open Graph,
keywords. Snapshots are stored under `.agentcms/research/<host>.json` with a timestamp so that
`compare_competitors` can diff runs ("12 new posts since last check").

`compare_competitors` produces: topics they cover that we do not (keyword and heading clusters),
publishing cadence, average length, structure patterns they use (FAQ, schema, question headings),
and a ranked list of opportunities with the evidence behind each.

### 6.4 Insights

- **Briefing**: counts per collection and status, drafts with age, stale published content,
  entries with weak metadata, low audit scores, orphans, new competitor content since last
  briefing, and an ordered list of next actions expressed as tool calls.
- **Suggestions**: new topics (gaps vs competitors, thin clusters, question headings seen on
  competitors), refreshes (stale, high-link-count), expansions (short posts in strong clusters),
  internal link opportunities.

### 6.5 Static build

`<outDir>/`:

```
content/<collection>/index.json        # list with core metadata
content/<collection>/<slug>.json       # frontmatter + html + text + toc + jsonld
taxonomy.json                          # categories and tags with counts
feeds/rss.xml  feeds/atom.xml  feeds/feed.json
sitemap.xml
llms.txt  llms-full.txt                # llmstxt.org format for answer engines
search-index.json                      # MiniSearch index
robots.txt                             # suggested rules incl. AI crawler directives
manifest.json                          # build info and content hashes
```

---

## 7. Phases (status)

| # | Phase | Deliverable | Status |
| --- | --- | --- | --- |
| 0 | Plan and scaffolding | this document, package, tsconfig, lint, test runner | done |
| 1 | Core | config, content store, markdown, deterministic metadata, validation | done |
| 2 | CLI + MCP (stdio) | commands, tools, resources, prompts, instructions, `init`, install docs | done |
| 3 | Analysis + insights | SEO/AEO/readability audits, briefing, suggestions, improve plan | done |
| 4 | AI providers | Anthropic, sampling, delegate; AI enrichment | done (Anthropic path exercised against the SDK types only; needs a live key to verify end to end) |
| 5 | Research | competitor discovery, extraction, snapshots, comparison | done (tested with mocked HTTP) |
| 6 | Build | static outputs | done |
| 7 | HTTP API | Hono + OpenAPI + MCP over HTTP + auth | done |
| 8 | Docs and polish | README, guides, release config | done; example project and npm publish are follow-ups |

## 9. Follow-ups

- Publish to npm as `agentcms` and point `$schema` URLs at the released schema.
- Verify the MCP Apps preview inside Claude Desktop and VS Code and tune the view (size notifications, theme following the host).
- Migrate to the MCP TypeScript SDK v2 packages (`@modelcontextprotocol/server`) once the Apps SDK 2.x is the only maintained line.
- Image handling for templates: responsive sizes and an `image` filter.
- Example site under `examples/` that consumes `public/cms/` with Astro.
- Web search for SERP checks (Anthropic `web_search` server tool) when the Anthropic provider is active.
- Elicitation (MCP) for publish/delete confirmations on clients that support it.
- Multi-language content (per-entry `language` is stored; audits and keyword extraction are English-first).
- Optional web-based read-only preview of the JSON output (explicitly out of scope today).

---

## 8. Quality bar

- Every engine has unit tests with fixtures; the MCP server is tested end to end over an
  in-memory transport; the API is tested with Hono's `app.request()`.
- `pnpm check` runs Biome, the TypeScript compiler and Vitest.
- No network in tests (fetch is mocked).
- The tool descriptions are the product: every tool explains when to use it, what it returns and
  what to do next.

---

## 10. Phase 9: managed templates and page rendering

Decision: agentcms renders the site itself. Templates are files the CMS manages the same way it
manages content: readable, editable, validated, previewed and audited through the agent surface,
with a default theme so a fresh project renders a complete site on its first build. People with an
existing site can switch page rendering off and keep consuming the JSON.

### Engine

LiquidJS. Safe by design (no arbitrary code in templates, so agent- and API-authored templates
cannot read files or make requests), widely known to models from Jekyll and Shopify, supports
layouts, includes and filters without a build step.

### Project layout

```
templates/
├── layouts/base.liquid            html shell: {{ head }}, header, footer
├── pages/home.liquid              /
├── pages/post.liquid              entries of kind post (also doc, custom)
├── pages/page.liquid              entries of kind page
├── pages/author.liquid            entries of kind author, with their posts
├── pages/collection.liquid        collection index, paginated
├── pages/term.liquid              one tag or category
├── pages/taxonomy.liquid          tag and category indexes
├── pages/404.liquid
├── partials/*.liquid              nav, footer, post-card, pagination, answer, takeaways, faq, toc, author-card, related
└── assets/styles.css, search.js
theme.json                         colours, fonts, layout, nav, footer, feature flags
```

`templates/pages/<collection>.liquid` overrides the kind template for one collection. Missing files
fall back to the bundled default theme file by file, so deleting a template is always safe.

### Output layout (changed)

`build.outDir` (default `dist`) is the site root. Pages render to `<path>/index.html`, assets to
`assets/<name>.<hash>.<ext>`, and the root-level files that must live at the root (sitemap.xml,
robots.txt, llms.txt, llms-full.txt, feeds/) go there. The JSON content API and search index move
under `build.dataPath` (default `cms`), so a headless user who sets `outDir: public` gets
`public/cms/...` plus a correct `public/sitemap.xml`. `build.html.enabled` (default true) controls
page rendering. `build.publicPath` is removed.

### Render context

Every template receives precomputed data from the same corpus the audits use:
`site` (config plus navigation), `theme` (tokens), `page` (kind, title, url, description),
`entry` (frontmatter, html, text, toc, readingTime, wordCount, resolved author, related entries,
jsonld), `entries` and `pagination` on lists, `collection`, `term`, `taxonomy`, `assets` (hashed
asset paths), `head` (the generated head block) and `build`. Filters: `absolute_url`, `json`,
`excerpt`, `slugify`, `markdown`, plus Liquid's own `date`, `truncatewords` and friends.

The CMS generates the entire SEO head block (title, description, canonical, robots, Open Graph,
Twitter card, article metadata, JSON-LD, feed links) and templates place it with `{{ head }}`.
Layouts missing `{{ head }}` fail validation, so a restyle cannot remove structured data.

### Managed template surface

Core: `TemplateStore` (list, get with the variables available to that template kind and a sample
context from a real entry, create, update with validation, delete, reset to the bundled default,
diff) and `ThemeStore` (theme.json). Validation parses the Liquid, renders against a sample
context, rejects syntax errors, warns on unknown variables and requires `{{ head }}` in layouts.

MCP tools: `list_templates`, `get_template`, `update_template`, `create_template`,
`delete_template` (confirm), `reset_template`, `get_theme`, `update_theme`, `list_routes`,
`preview_page`, `audit_pages`. Resources: `agentcms://template/{path}`, `agentcms://theme`,
`agentcms://preview/{collection}/{slug}`. Prompts: `restyle_site`, `add_section`,
`fix_page_audit`. The server instructions and guide gain a presentation section: read before
editing, tokens before templates, never put content in a template, preview then build.

CLI: `agentcms templates list|get|reset|validate`, `agentcms theme get|set`,
`agentcms preview <slug> [--screenshot file] [--mobile]`, and `agentcms serve` also serves the built
site at `/` so an agent can hand the user a link. API: `/v1/templates*`, `/v1/theme`,
`/v1/preview/{collection}/{slug}`, `/v1/pages/audit`.

### Previews

`preview_page` renders one route in memory, runs the page audit and returns three things so every
client gets the best it can show: a self-contained HTML document (CSS inlined, absolute URLs) that
Claude can open as an artifact, PNG screenshots at desktop and mobile widths taken with headless
Chromium through `playwright-core` (an optional peer dependency; without it the tool says how to
enable screenshots and still returns the HTML), and an MCP Apps view: the tool points at a
`ui://agentcms/preview` resource that hosts with MCP Apps support (Claude among them) render in a
sandboxed iframe inside the chat, while other hosts fall back to the text and image blocks.

### Rendered-page audit

A new audit area, `page`, checks the final HTML rather than the Markdown: `<title>` and meta
description match the entry, canonical and robots tags, complete Open Graph and Twitter card,
parseable JSON-LD, exactly one H1, `lang` and viewport, images with alt, internal links that
resolve to built routes, landmarks (header, main, nav, footer), a skip link, and page weight.
`audit_content` includes it for entries when page rendering is on; `audit_pages` covers every
route including lists; the briefing reports failing pages.

### Default theme

Semantic HTML, no framework, one stylesheet driven by `theme.json` tokens through CSS custom
properties, light and dark via the system preference, responsive from phone width up. Post pages
render the answer-first block, key takeaways, table of contents, body, FAQ as collapsible
details, author card and related posts, so the AEO structures the content model produces are
visible by default. Dependency-free client-side search over the JSON index. Every template carries
a short comment stating what it renders and which variables it uses.

### Status

| Step | Status |
| --- | --- |
| Config and output layout change, data path, html toggle | done |
| Default theme (templates, assets, theme.json) | done |
| Renderer, context builder, head generator, page builder, assets | done |
| Template and theme stores with validation, diff, reset | done |
| Rendered-page audit | done |
| Previews: HTML, screenshots, MCP Apps resource | done (MCP Apps view uses the 1.7 Apps SDK, compatible with MCP SDK 1.x; live-host rendering not verified in this session) |
| MCP tools, resources, prompts; guide and instructions | done |
| CLI and API surface, static serving | done |
| Tests and docs | done |
