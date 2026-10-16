import path from "node:path";
import { CmsError } from "../util/errors.ts";
import { exists, readJsonIfExists, writeJson } from "../util/fs.ts";
import { CONFIG_FILENAME, type CmsConfig, CmsConfigSchema } from "./schema.ts";

/** Walk up from `cwd` until a config file is found. Returns the directory containing it. */
export async function findProjectRoot(cwd: string = process.cwd()): Promise<string | undefined> {
  let dir = path.resolve(cwd);
  for (;;) {
    if (await exists(path.join(dir, CONFIG_FILENAME))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export async function loadConfig(root: string): Promise<CmsConfig> {
  const file = path.join(root, CONFIG_FILENAME);
  const raw = await readJsonIfExists(file);
  if (raw === undefined) {
    throw new CmsError(
      "CONFIG",
      `No ${CONFIG_FILENAME} found in ${root}. Run \`agentcms init\` to create a project.`,
    );
  }
  const parsed = CmsConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CmsError("CONFIG", `Invalid ${CONFIG_FILENAME}`, parsed.error.issues);
  }
  return parsed.data;
}

export async function saveConfig(root: string, config: CmsConfig): Promise<void> {
  const parsed = CmsConfigSchema.parse(config);
  await writeJson(path.join(root, CONFIG_FILENAME), parsed);
}

export function configPath(root: string): string {
  return path.join(root, CONFIG_FILENAME);
}
