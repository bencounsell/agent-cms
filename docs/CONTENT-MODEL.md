# Content model and configuration

## Layout

```
my-site/
├── agentcms.config.json
├── AGENTS.md
├── content/
│   ├── posts/<slug>.md
│   ├── pages/<slug>.md
│   └── authors/<slug>.md
├── templates/                 # Liquid templates (layouts, pages, partials, assets); see TEMPLATES.md
├── theme.json                 # design tokens
├── .agentcms/                 # cache: research/<host>.json, last-briefing.json, last-comparison.json
└── dist/                      # built site, with the JSON API under dist/cms/
```

## Entry files

One Markdown file per entry: YAML frontmatter, then the body. Files can be hand-written; `agentcms validate` checks them and the next CMS save assigns missing ids.

```yaml
---
id: 4d8c4f7e-…                 # stable uuid
title: Why agent-first CMSs win
slug: why-agent-first-cmss-win
status: draft                  # draft | review | published | archived
publishedAt: 2026-10-16T09:00:00.000Z
updatedAt: 2026-10-16T09:00:00.000Z
createdAt: 2026-10-16T09:00:00.000Z
author: ben                    # slug in the authors collection
category: Engineering
tags: [cms, mcp, ai-agents]
keywords: [agent-first cms, mcp cms]
description: Meta description, 70–160 characters.
excerpt: Plain-text teaser for listing pages.
image: /images/agent-first.png
imageAlt: Diagram of an agent operating a CMS
canonical: https://…
language: en
seo: { title: …, description: …, focusKeyword: agent-first cms, noindex: false }
social:
  og: { title, description, image, type }
  twitter: { card, title, description, image, site }
  posts: { linkedin: …, x: … }          # model-written announcement copy
aeo:
  answer: 40–70 word direct answer, quotable on its own
  keyTakeaways: [ … ]
  faq: [{ question, answer }]
  questions: [ … ]                      # search questions this should rank for
sources: [https://…]
related: [other-slug]
schema: { … }                           # merged over generated JSON-LD
readingTime: 6
wordCount: 1340
generated: { fields: [description, tags, …], provider: anthropic+deterministic, at: … }
review: [category]                      # fields to confirm
---

Body in Markdown (GFM). No H1: the title is the H1.
```

Custom fields declared in a collection's `fields` live alongside these keys.

## Status lifecycle

`draft → review → published → archived`. `set_status`/`agentcms content publish` set `publishedAt` on first publish and run the audit gate (`seo.minAuditScoreToPublish`, default 60; entries with error-level findings never pass without `force`). Builds include only published entries unless `build.includeDrafts` is true.

## Metadata generation

Groups: `description`, `excerpt`, `category`, `tags`, `keywords`, `social`, `aeo`, `schema`, `related`, `readingTime`. A collection's `metadata.auto` lists the groups generated automatically on create and on body/title changes.

Rules:

- A field a human wrote (not listed in `generated.fields`) is never overwritten unless `force` is passed.
- Derived facts (`readingTime`, `wordCount`, JSON-LD) are always refreshed.
- Deterministic generation always runs; a model (Anthropic API, MCP sampling, or the agent via `submit_metadata`) improves the text fields.
- `review` lists fields the generator is unsure about (e.g. a category guessed with low confidence, a description cut from the first paragraph). Clear it with `update_content { review: [] }` once confirmed.

## Configuration (`agentcms.config.json`)

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/bencounsell/agent-cms/main/schemas/config.schema.json",
  "version": 1,
  "site": {
    "name": "My Site", "url": "https://mysite.com", "description": "…", "language": "en",
    "audience": "engineering managers", "topics": ["on-call", "incident response"], "tone": "direct, practical",
    "organization": { "name": "…", "url": "…", "logo": "/logo.png" },
    "defaultAuthor": "ben",
    "social": { "twitter": "@mysite", "profiles": ["https://linkedin.com/company/mysite"] }
  },
  "collections": [
    { "name": "posts", "kind": "post", "path": "content/posts", "urlPattern": "/blog/{slug}",
      "filePattern": "{slug}", "fields": [ { "name": "series", "type": "string" } ],
      "metadata": { "auto": ["description","excerpt","category","tags","keywords","social","aeo","schema","related","readingTime"], "maxTags": 8, "maxKeywords": 10 },
      "listable": true },
    { "name": "pages", "kind": "page", "path": "content/pages", "urlPattern": "/{slug}" },
    { "name": "authors", "kind": "author", "path": "content/authors", "urlPattern": "/authors/{slug}", "listable": false }
  ],
  "taxonomy": {
    "categories": [ { "name": "Engineering", "description": "…", "keywords": ["mcp", "api"] } ],
    "categoryPolicy": "open",          // closed: only listed categories
    "tagPolicy": "open", "allowedTags": []
  },
  "ai": { "provider": "auto", "model": "claude-opus-5-5", "effort": "medium", "maxTokens": 8000 },
  "research": { "competitors": [ { "url": "https://competitor.com/blog", "name": "Competitor" } ],
                "maxPagesPerSite": 40, "requestDelayMs": 600, "refreshAfterDays": 7, "pathPrefixes": [] },
  "seo": { "targetWordCount": 1200, "titleLength": { "min": 30, "max": 60 }, "descriptionLength": { "min": 70, "max": 160 },
           "staleAfterDays": 180, "minInternalLinks": 2, "minAuditScoreToPublish": 60 },
  "build": { "outDir": "dist", "dataPath": "cms", "feeds": true, "feedLimit": 20, "sitemap": true,
             "llmsTxt": true, "searchIndex": true, "robots": true, "includeDrafts": false,
             "html": { "enabled": true, "templatesDir": "templates", "pageSize": 10, "assetsPath": "/assets",
                       "tagsPath": "/tags", "categoriesPath": "/categories", "nav": [ { "label": "Blog", "url": "/blog/" } ] } }
}
```

Collection kinds decide the JSON-LD type (`post` → BlogPosting, `doc` → TechArticle, `page` → WebPage, `author` → Person, `custom` → Article) and which audit checks apply. URL patterns accept `{slug}`, `{year}`, `{month}`, `{day}`, `{category}`, `{collection}`.

Change configuration with `update_config` (MCP), `PATCH /v1/config` (API), or by editing the file.
