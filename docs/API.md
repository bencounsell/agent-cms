# HTTP API

Start it with `agentcms serve [--port 4321] [--host 127.0.0.1]`. The OpenAPI 3.1 document is at `GET /openapi.json`; `GET /health` reports the version, project root and AI mode.

Authentication: set `AGENTCMS_API_TOKEN` and send `Authorization: Bearer <token>` (or `x-api-key`). Loopback requests pass without a token unless `AGENTCMS_REQUIRE_TOKEN=1`.

Errors are `{ "error": { "code", "message", "details?" } }` with `400` validation, `404` not found, `409` conflict or blocked (for example the publish gate), `502` network, `503` model unavailable.

| Method and path | Purpose |
| --- | --- |
| `GET /v1/content/{collection}?status&tag&category&author&q&limit&offset&sort&order` | List entries |
| `POST /v1/content/{collection}` | Create (body: entry fields + `enrich?`) |
| `GET /v1/content/{collection}/{slug}` | Read |
| `PATCH /v1/content/{collection}/{slug}` | Update (partial) |
| `DELETE /v1/content/{collection}/{slug}` | Delete |
| `POST /v1/content/{collection}/{slug}/status` | `{ status, force? }` (409 with `blocked` when the audit gate refuses) |
| `POST /v1/content/{collection}/{slug}/enrich` | `{ fields?, force?, deterministicOnly? }` |
| `POST /v1/content/{collection}/{slug}/metadata` | Submit agent-generated metadata `{ metadata, fields? }` |
| `POST /v1/enrich` | Enrich many `{ collection?, status?, fields?, force? }` |
| `GET /v1/content/{collection}/{slug}/audit` · `GET /v1/audit?collection&status` | Audits |
| `GET /v1/content/{collection}/{slug}/improve` | Improvement plan |
| `GET /v1/validate` | Validate all files |
| `GET /v1/search?q&collection&status&limit` | Full-text search |
| `GET /v1/briefing` | Briefing with next actions |
| `GET /v1/suggestions?limit&focus&ai=false` | Content suggestions |
| `GET /v1/competitors` · `POST /v1/competitors { url, name?, notes? }` · `DELETE /v1/competitors/{host}` | Track competitors |
| `POST /v1/competitors/{host}/refresh` · `POST /v1/competitors/refresh { onlyStale? }` | Crawl |
| `GET /v1/competitors/compare` | Gap analysis |
| `GET /v1/templates[?path=]` · `PUT /v1/templates { path, source }` · `DELETE /v1/templates?path=` · `POST /v1/templates/reset { path }` | Managed templates (PUT validates; 400 with errors when rejected) |
| `GET /v1/theme` · `PATCH /v1/theme` | Theme tokens |
| `GET /v1/routes?drafts=true` | Pages the site renders |
| `GET /v1/preview?path=/blog/x/` (or `collection&slug`; `format=json` adds the audit) | Rendered page |
| `GET /v1/pages/audit` | Rendered-page audit of every route |
| `GET /*` | The built site (`build.outDir`) when it exists |
| `POST /v1/build { outDir?, includeDrafts? }` | Static build (pages, assets and data) |
| `GET /v1/config` · `PATCH /v1/config` | Configuration (deep merge; `null` deletes a key) |
| `ALL /mcp` | MCP Streamable HTTP endpoint (stateful sessions via `mcp-session-id`) |

Example:

```bash
curl -s -X POST http://127.0.0.1:4321/v1/content/posts \
  -H 'content-type: application/json' \
  -d '{"title":"Hello","body":"Hello is a greeting.\n\n## Why say hello?\n\nBecause it is polite."}' | jq .audit.scores
```

The TypeScript library exposes the same operations: `import { Cms } from "agentcms"; const cms = await Cms.open({ root }); await cms.briefing();`.
