import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/api/app.ts";
import { GOOD_POST, makeProject, openCms } from "./helpers.ts";

let project: Awaited<ReturnType<typeof makeProject>>;
let app: ReturnType<typeof createApp>;
const H = { authorization: "Bearer secret", "content-type": "application/json" };
// biome-ignore lint/suspicious/noExplicitAny: test convenience
const body = async (res: Response): Promise<any> => res.json();

beforeEach(async () => {
  project = await makeProject();
  const cms = await openCms(project.root);
  await cms.create("posts", {
    title: "What is an agent-first CMS?",
    body: GOOD_POST,
    status: "published",
  });
  app = createApp(cms, { token: "secret", requireToken: true });
});
afterEach(() => project.cleanup());

describe("HTTP API", () => {
  it("serves health and an OpenAPI 3.1 document without auth", async () => {
    expect((await body(await app.request("/health"))).ok).toBe(true);
    const spec = await body(await app.request("/openapi.json"));
    expect(spec.openapi).toBe("3.1.0");
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining([
        "/v1/content/{collection}",
        "/v1/briefing",
        "/v1/competitors/compare",
        "/v1/build",
      ]),
    );
  });

  it("requires a bearer token", async () => {
    expect((await app.request("/v1/briefing")).status).toBe(401);
    expect(
      (await app.request("/v1/briefing", { headers: { authorization: "Bearer wrong" } })).status,
    ).toBe(401);
    expect((await app.request("/v1/briefing", { headers: H })).status).toBe(200);
  });

  it("runs the content lifecycle", async () => {
    const created = await app.request("/v1/content/posts", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ title: "API post", body: "Short body about the API." }),
    });
    expect(created.status).toBe(201);
    const slug = (await body(created)).entry.slug;
    expect((await body(await app.request("/v1/content/posts", { headers: H }))).total).toBe(2);
    const patched = await app.request(`/v1/content/posts/${slug}`, {
      method: "PATCH",
      headers: H,
      body: JSON.stringify({ tags: ["x"] }),
    });
    expect((await body(patched)).entry.frontmatter.tags).toEqual(["x"]);
    const audit = await body(await app.request(`/v1/content/posts/${slug}/audit`, { headers: H }));
    expect(audit.scores.overall).toBeDefined();
    const gate = await app.request(`/v1/content/posts/${slug}/status`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ status: "published" }),
    });
    expect(gate.status).toBe(409);
    expect(
      (
        await app.request("/v1/content/posts", {
          method: "POST",
          headers: H,
          body: JSON.stringify({ nope: 1 }),
        })
      ).status,
    ).toBe(400);
    expect((await app.request("/v1/content/posts/missing", { headers: H })).status).toBe(404);
    expect(
      (await app.request(`/v1/content/posts/${slug}`, { method: "DELETE", headers: H })).status,
    ).toBe(200);
    expect((await body(await app.request("/v1/search?q=agent", { headers: H }))).hits.length).toBe(
      1,
    );
  });

  it("exposes templates, theme, routes and previews, and serves the built site", async () => {
    const cms = await openCms(project.root);
    await cms.updateConfig({ build: { html: { enabled: true } } });
    const siteApp = createApp(cms, { token: "secret", requireToken: true });
    const list = await body(await siteApp.request("/v1/templates", { headers: H }));
    expect(list.templates.length).toBeGreaterThan(15);
    const put = await siteApp.request("/v1/templates", {
      method: "PUT",
      headers: H,
      body: JSON.stringify({ path: "layouts/base.liquid", source: "<html></html>" }),
    });
    expect(put.status).toBe(400);
    expect(
      (await body(await siteApp.request("/v1/theme", { headers: H }))).theme.colors.accent,
    ).toBe("#2457d6");
    expect(
      (await body(await siteApp.request("/v1/routes", { headers: H }))).routes.length,
    ).toBeGreaterThan(3);
    const html = await siteApp.request("/v1/preview?path=/", { headers: H });
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(await html.text()).toContain("<title>Test Site");
    const audit = await body(await siteApp.request("/v1/pages/audit", { headers: H }));
    expect(audit.results.length).toBeGreaterThan(3);
    await cms.build();
    const page = await siteApp.request("/blog/what-is-an-agent-first-cms/", { headers: H });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("What is an agent-first CMS?");
  });

  it("speaks MCP over streamable HTTP with sessions", async () => {
    const init = await app.request("/mcp", {
      method: "POST",
      headers: { ...H, accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        },
      }),
    });
    expect(init.status).toBe(200);
    const sid = init.headers.get("mcp-session-id");
    expect(sid).toBeTruthy();
    expect(await init.text()).toContain("agentcms");
    const list = await app.request("/mcp", {
      method: "POST",
      headers: { ...H, accept: "application/json, text/event-stream", "mcp-session-id": sid! },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(list.status).toBe(200);
    expect(await list.text()).toContain("get_briefing");
    expect(
      (
        await app.request("/mcp", {
          method: "POST",
          headers: {
            ...H,
            accept: "application/json, text/event-stream",
            "mcp-session-id": "unknown",
          },
          body: "{}",
        })
      ).status,
    ).toBe(404);
  });
});
