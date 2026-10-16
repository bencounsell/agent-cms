# SEO and AEO checks

`audit_content` scores five areas; each check has a weight, a severity and a fix. Scores are the share of passed weight per area; `overall` is the weighted total. An entry is **publishable** when `overall ≥ seo.minAuditScoreToPublish` and no error-level check fails.

## SEO

| Check | What it looks at |
| --- | --- |
| `seo.title.length` | 30–60 characters (over is a warning, under is info) |
| `seo.description.present` / `.length` | Meta description exists, 70–160 characters |
| `seo.headings.no-h1-in-body` / `.hierarchy` / `.present` | No `#` in the body, no skipped levels, at least two H2 sections |
| `seo.keyword.title` / `.description` / `.intro` / `.slug` | Focus keyword placement (`seo.focusKeyword` or first keyword) |
| `seo.images.alt` / `seo.image.featured` | Alt text on every image, featured image set |
| `seo.wordcount` | At least 60% of `seo.targetWordCount` |
| `seo.category` / `seo.tags` | Taxonomy filled in |
| `seo.slug.quality` | Lowercase, hyphenated, ≤ 75 chars |
| `seo.duplicate.title` / `.description` | Unique across the site |

## AEO (answer-engine optimisation)

What makes content quotable by ChatGPT, Perplexity, Google AI Overviews and Claude.

| Check | What it looks at |
| --- | --- |
| `aeo.answer-first` | `aeo.answer` set, or an opening paragraph ≤ 70 words containing the focus keyword |
| `aeo.question-headings` | At least one heading phrased as a question |
| `aeo.key-takeaways` | `aeo.keyTakeaways` (≥ 3) or a "Key takeaways / TL;DR" section |
| `aeo.faq` / `aeo.faq-schema` | FAQ pairs in `aeo.faq` (emits FAQPage JSON-LD) |
| `aeo.target-questions` | `aeo.questions` lists the questions to rank for |
| `aeo.sources` | ≥ 2 external links or listed `sources` |
| `aeo.author` / `aeo.date-modified` | E-E-A-T signals: author entry, modification date |
| `aeo.scannable` | Paragraphs ≤ 90 words, lists or tables present |
| `aeo.definition` | The focus keyword is defined ("X is …") early |
| `aeo.llms-txt` | `build.llmsTxt` enabled |

## Readability

Flesch Reading Ease (≥ 50), Flesch–Kincaid grade (≤ 11), long sentences (≤ 25% over 25 words), passive voice (≤ 20%), long paragraphs (none over 150 words).

## Links

Internal links ≥ `seo.minInternalLinks`, at least one external link, no broken internal links, published entries have inbound links (orphans are flagged).

## Freshness

Published entries updated within `seo.staleAfterDays`.

## Writing checklist agents are given

1. Open with a 40–70 word direct answer; copy it into `aeo.answer`.
2. H2 headings phrased as the questions people ask; answer in the first sentence under each.
3. "Key takeaways" list near the top; FAQ (3–5 real questions) near the end.
4. Define the focus keyword early; use it in title, description, first paragraph, slug.
5. Link to two related entries by path and cite at least one authoritative source.
6. Short paragraphs, lists and tables, alt text on images, no H1 in the body.
7. Never invent facts, statistics, quotes or sources.

## Structured data emitted at build

Per entry: `BlogPosting`/`TechArticle`/`WebPage`/`Person` with author, publisher, dates, keywords, section, word count, reading time, language, abstract (the AEO answer) and citations; `FAQPage` when `aeo.faq` is set; `BreadcrumbList`. `schema` in frontmatter is merged over the main entity.

## Answer-engine files

`llms.txt` (llmstxt.org format: site summary, one line per entry with its description, links to the full text and the JSON API) and `llms-full.txt` (every entry in Markdown with its answer, takeaways and FAQ up front). `robots.txt` suggests allowing GPTBot, ClaudeBot, PerplexityBot, Google-Extended and Applebot-Extended so the content can be cited.
