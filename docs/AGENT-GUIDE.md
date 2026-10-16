# agentcms agent guide

agentcms is a headless CMS designed to be operated by AI agents. There is no web admin. Everything happens through MCP tools, the `agentcms` CLI, or the HTTP API, and the only output is static files.

## Mental model

- **Content is files.** Each entry is `content/<collection>/<slug>.md`: YAML frontmatter plus a Markdown body. Git is the history. Humans can edit the files directly; the CMS re-reads them on every call.
- **Metadata is generated.** On create and update the CMS fills in description, excerpt, category, tags, keywords, focus keyword, social cards, a direct answer, key takeaways, FAQ pairs, target questions, related entries, reading time and JSON-LD. Fields it generated are listed in `generated.fields`; fields it is unsure about are listed in `review`.
- **Two layers of generation.** Deterministic rules always run (no network). A model improves the result when one is available: the Anthropic API (credentials in the environment), MCP sampling (the connected client's model), or delegation to you (the result contains `delegated`; you produce the JSON and call `submit_metadata`).
- **Audits gate publishing.** `audit_content` scores SEO, AEO (answer-engine optimisation), readability, links and freshness. `set_status` refuses to publish below `seo.minAuditScoreToPublish` unless forced.
- **Output is static.** `build_site` writes a JSON content API, RSS/Atom/JSON feeds, sitemap.xml, llms.txt and llms-full.txt, a MiniSearch index, taxonomy.json and a suggested robots.txt into `build.outDir`. The site (Astro, Next, Eleventy, anything) consumes those files.

## Session workflow

1. `get_briefing` - what changed, what is stale, what needs review, what competitors published, what to do next.
2. Pick work from `nextActions` or the user's request.
3. For new content: `search_content` for duplicates, `suggest_content` for angles, write, `create_content`, fix audit findings, ask before publishing.
4. For existing content: `improve_content` gives a prioritised plan with link candidates, FAQ candidates and competitor benchmarks. Apply with `update_content`.
5. `build_site` when the user wants fresh output.

## Writing for search and answer engines

- Open with the answer: 40-70 words that fully answer the main question. The same text goes in `aeo.answer`.
- Use H2 headings that are the questions people search for ("How does X work?"). Answer in the first sentence under each heading.
- Include a "Key takeaways" list near the top and an "FAQ" section near the end. The CMS extracts both into `aeo` and emits FAQPage structured data.
- Define the focus keyword early ("X is ..."). Use it in the title, the description, the first paragraph and ideally the slug.
- Link to at least two related entries by path (for example `/blog/other-post`) and to at least one authoritative external source.
- Paragraphs under 90 words, lists and tables for comparisons, no H1 in the body, descriptive alt text on images.
- Keep facts grounded in the source material. Never fabricate statistics, quotes, or citations.

## Frontmatter reference

| Field | Meaning |
| --- | --- |
| id | Stable UUID, never changes |
| title, slug, status | status: draft, review, published, archived |
| publishedAt, updatedAt, createdAt | ISO timestamps, maintained automatically |
| author | Slug of an entry in the authors collection |
| category, tags, keywords | Taxonomy; `seo.focusKeyword` is the primary phrase |
| description, excerpt | Meta description (70-160 chars) and listing teaser |
| image, imageAlt, canonical, language | Media and canonical URL |
| seo | title, description, focusKeyword, noindex |
| social | og and twitter card fields, plus generated social posts |
| aeo | answer, keyTakeaways, faq[], questions[] |
| sources, related | Citations and related slugs |
| schema | Overrides merged into the generated JSON-LD |
| readingTime, wordCount | Derived |
| generated, review | Provenance of machine-written fields and fields to confirm |

## Status lifecycle

draft -> review -> published -> archived. `set_status` sets publishedAt on first publish and runs the audit gate. Only published entries appear in builds unless `build.includeDrafts` is true.

## Metadata groups (for enrich_metadata fields)

description, excerpt, category, tags, keywords, social, aeo, schema, related, readingTime. The collection's `metadata.auto` policy decides which run automatically. `force: true` overwrites human-written values; by default only empty or previously generated fields change.

## Competitor research

`add_competitor` registers a site. `research_competitors` discovers its sitemap, fetches recent pages politely (robots.txt, one request at a time) and records titles, headings, word counts, dates, structured data and FAQ usage. `compare_competitors` turns that into topic gaps, cadence, depth and structure comparisons with evidence. Snapshots live in `.agentcms/research/`; each refresh records which pages are new.

## Rules of engagement

- Ask before publishing, deleting, or renaming a published entry.
- Do not overwrite human-written metadata; surface `review` fields.
- Prefer updating an existing entry to creating a near-duplicate.
- Keep the user informed in plain language: what you changed, what the audit says, what you recommend next.

## CLI equivalents

`agentcms briefing`, `agentcms content list|get|create|update|delete|publish`, `agentcms enrich`, `agentcms audit`, `agentcms improve`, `agentcms suggest`, `agentcms research add|list|refresh|compare`, `agentcms build`, `agentcms validate`, `agentcms serve` (HTTP API + MCP over HTTP), `agentcms mcp` (stdio MCP).
