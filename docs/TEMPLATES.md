# Templates, theme and previews

agentcms renders the site itself from Liquid templates and a `theme.json` of design tokens. Templates are managed the same way content is: readable, editable, validated, previewed and audited through the MCP tools, the CLI or the HTTP API. A bundled default theme fills in any file the project does not have, so the site always renders and deleting a template is always safe.

Turn page rendering off with `build.html.enabled: false` to use agentcms headlessly and consume the JSON API from your own site.

## Layout

```
templates/
├── layouts/base.liquid          the <html> shell; must contain {{ head | raw }}
├── pages/home.liquid            /
├── pages/post.liquid            post, doc and custom entries
├── pages/page.liquid            page entries
├── pages/author.liquid          author entries, with their posts
├── pages/collection.liquid      collection index, paginated (/blog/, /blog/page/2/)
├── pages/term.liquid            one tag or category (/tags/x/, /categories/y/)
├── pages/taxonomy.liquid        /tags/ and /categories/
├── pages/404.liquid             /404.html
├── partials/…                   nav, footer, post-card, pagination, answer, takeaways, faq, toc, author-card, related
└── assets/styles.css, search.js
theme.json
```

`pages/<collection>.liquid` (for example `pages/posts.liquid`) overrides the kind template for one collection.

## Liquid conventions

- Page templates start with `{% layout "layouts/base" %}` and put their markup in `{% block content %}…{% endblock %}`.
- Partials are rendered with explicit arguments: `{% render "partials/post-card", entry: entry %}`. `{% include %}` shares the whole scope (used for nav and footer).
- Every output is HTML-escaped. Use `| raw` only for `entry.html` and `head`.
- Extra filters: `absolute_url`, `json`, `excerpt: 160`, `slugify`, `markdown`, plus Liquid's own (`date`, `truncatewords`, `downcase`, …).

## Variables

| Variable | Contents |
| --- | --- |
| `site` | `name`, `url`, `description`, `language`, `nav[{label,url}]`, `dataPath`, `searchCollection`, `feeds`, `llmsTxt`, `social`, `organization` |
| `theme` | the resolved tokens: `colors`, `dark`, `fonts`, `layout`, `features`, `footer` |
| `page` | `kind` (home, entry, collection, term, taxonomy, 404), `title`, `description`, `path`, `url`, `language` |
| `entry` | the entry's frontmatter plus `path`, `url`, `html` (`\| raw`), `text`, `toc[{depth,text,id}]`, `headings`, `readingTime`, `wordCount`, `categoryUrl`, `tagLinks[{name,url}]`, `aeo{answer,keyTakeaways,faq,questions}`, `custom` |
| `author` | the resolved author entry summary, or null |
| `related` | summaries of `entry.related` |
| `entries` | entry summaries for lists (and an author's posts) |
| `pagination` | `page`, `totalPages`, `perPage`, `total`, `prevUrl`, `nextUrl`, `pages[{number,url}]` |
| `collection` | `name`, `label`, `description`, `url`, `kind` |
| `term`, `terms` | the current tag/category, and all of them on index pages |
| `taxonomy` | `categories[{name,url,count}]`, `tags[…]` |
| `assets` | hashed public paths, e.g. `assets['styles.css']` |
| `head` | the generated SEO block (`{{ head \| raw }}` inside `<head>`) |
| `build` | `generatedAt`, `year`, `version` |

`get_template` returns this list together with a sample context taken from a real page.

## The head block

The CMS generates the entire `<head>` metadata: title, description, canonical, robots, Open Graph, Twitter card, article dates and tags, JSON-LD, feed links, and the theme tokens as CSS custom properties. Layouts place it with `{{ head | raw }}`; a layout without it is rejected by `update_template`. Templates never hand-write meta tags or structured data.

## Theme tokens (`theme.json`)

```json
{
  "colors": { "background": "#ffffff", "surface": "#f6f7f9", "text": "#1b1f24", "muted": "#5c6572", "border": "#e2e6ea", "accent": "#2457d6", "accentText": "#ffffff" },
  "dark":   { "background": "#0f1216", "surface": "#171b21", "text": "#e8ebef", "muted": "#9aa4b1", "border": "#2a313a", "accent": "#7aa2ff", "accentText": "#0f1216" },
  "fonts":  { "body": "system-ui, sans-serif", "heading": "inherit", "mono": "ui-monospace, monospace" },
  "layout": { "maxWidth": "72rem", "proseWidth": "44rem", "radius": "0.5rem" },
  "features": { "darkMode": true, "toc": true, "answerBox": true, "takeaways": true, "faq": true, "authorCard": true, "related": true, "search": true },
  "footer": { "text": "" }
}
```

Tokens become `--color-*`, `--font-*`, `--max-width`, `--prose-width` and `--radius` custom properties. Change them with `update_theme` (MCP), `agentcms theme set colors.accent=#ff0066`, or `PATCH /v1/theme`.

## Tools

| MCP tool | CLI | HTTP |
| --- | --- | --- |
| `list_templates` | `agentcms templates list` | `GET /v1/templates` |
| `get_template` | `agentcms templates get <path> [--vars]` | `GET /v1/templates?path=` |
| `update_template`, `create_template` | edit the file, then `agentcms templates validate` | `PUT /v1/templates` |
| `delete_template` | delete the file | `DELETE /v1/templates?path=` |
| `reset_template` | `agentcms templates reset <path>` | `POST /v1/templates/reset` |
| `get_theme`, `update_theme` | `agentcms theme get\|set\|reset` | `GET\|PATCH /v1/theme` |
| `list_routes` | `agentcms routes` | `GET /v1/routes` |
| `preview_page` | `agentcms preview <path\|slug> [-o page.html] [--screenshot shot.png] [--mobile]` | `GET /v1/preview?path=` |
| `audit_pages` | `agentcms audit --pages` | `GET /v1/pages/audit` |

`agentcms templates eject` copies every bundled file into `templates/` (`init` does this for new projects).

## Validation

`update_template` and `create_template` parse the Liquid, reject syntax errors, require `{{ head | raw }}` in layouts, warn about variables templates do not receive (loop and assign names are understood), and render page templates against a real route before writing. The result carries a diff and, for pages and layouts, the rendered page's audit score.

## Previews

`preview_page` renders one route without building and returns three things so every client can show the best it supports:

1. A self-contained HTML document (styles inlined, scripts removed, links absolute) in `structuredContent.html`. Claude can open it as an artifact.
2. PNG screenshots at desktop (1280×900) and/or mobile (390×844) width as image blocks, when headless Chromium is available: install `playwright-core` and run `npx playwright install chromium`, or point `AGENTCMS_CHROMIUM_PATH` at an existing Chromium binary. Without a browser the result says so and still includes the HTML.
3. An MCP Apps view: the tool points at the `ui://agentcms/preview.html` resource, which hosts with MCP Apps support (Claude among them) render inline in the chat with desktop/mobile toggles and the audit summary. Other hosts fall back to the text and image blocks.

`agentcms serve` also serves the built site at `/`, so an agent can hand the user a link after `build_site`.

## Rendered-page audit

The `page` audit area checks the final HTML: title and description match the entry, canonical and robots tags, Open Graph and Twitter card, parseable JSON-LD, exactly one H1, `lang` and viewport, image alt attributes, header/nav/main/footer landmarks, a skip link, internal links that resolve to built routes, and page weight. Entry audits include it when page rendering is on; `audit_pages` covers every route.
