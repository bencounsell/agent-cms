import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Cms } from "../core/cms.ts";
import { log } from "../core/util/log.ts";
import { createMcpServer } from "./server.ts";

export async function runStdio(opts: { root?: string; cwd?: string } = {}): Promise<void> {
  const cms = await Cms.open(opts);
  const server = createMcpServer(cms);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info(`agentcms MCP server ready (project: ${cms.root}, ai: ${cms.ai.mode})`);
}
