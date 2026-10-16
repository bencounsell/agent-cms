import { serve as honoServe } from "@hono/node-server";
import type { Cms } from "../core/cms.ts";
import { log } from "../core/util/log.ts";
import { type ApiOptions, createApp } from "./app.ts";

export async function serve(
  cms: Cms,
  opts: { port?: number; host?: string } & ApiOptions = {},
): Promise<{ close: () => Promise<void>; url: string }> {
  const app = createApp(cms, opts);
  const port = opts.port ?? 4321;
  const host = opts.host ?? "127.0.0.1";
  return new Promise((resolve) => {
    const server = honoServe({ fetch: app.fetch, port, hostname: host }, (info) => {
      const url = `http://${info.address === "::" ? "localhost" : info.address}:${info.port}`;
      const tokenNote = process.env.AGENTCMS_API_TOKEN
        ? "bearer token required for non-loopback clients"
        : "no token configured (set AGENTCMS_API_TOKEN before exposing this)";
      process.stderr.write(
        `agentcms API listening on ${url}\n  OpenAPI: ${url}/openapi.json\n  MCP:     ${url}/mcp\n  ${tokenNote}\n`,
      );
      log.info("serving", { url });
      resolve({ url, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}
