import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function readText(p: string): Promise<string> {
  return readFile(p, "utf8");
}

export async function readTextIfExists(p: string): Promise<string | undefined> {
  try {
    return await readFile(p, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export async function readJson<T = unknown>(p: string): Promise<T> {
  return JSON.parse(await readFile(p, "utf8")) as T;
}

export async function readJsonIfExists<T = unknown>(p: string): Promise<T | undefined> {
  const text = await readTextIfExists(p);
  return text === undefined ? undefined : (JSON.parse(text) as T);
}

/** Write atomically: write to a temp sibling then rename over the target. */
export async function writeText(p: string, content: string): Promise<void> {
  await ensureDir(path.dirname(p));
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, p);
}

export async function writeBuffer(p: string, content: Buffer): Promise<void> {
  await ensureDir(path.dirname(p));
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, p);
}

export async function writeJson(p: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value, null, 2);
  if (text === undefined) throw new Error(`Refusing to write ${p}: value is not JSON-serialisable`);
  await writeText(p, `${text}\n`);
}

export async function remove(p: string): Promise<void> {
  await rm(p, { force: true, recursive: true });
}

/** List files (not directories) in a directory with one of the given extensions. */
export async function listFiles(dir: string, extensions: string[]): Promise<string[]> {
  if (!(await exists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && extensions.some((ext) => e.name.endsWith(ext)))
    .map((e) => path.join(dir, e.name))
    .sort();
}

export async function mtimeMs(p: string): Promise<number> {
  return (await stat(p)).mtimeMs;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
