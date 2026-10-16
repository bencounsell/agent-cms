import path from "node:path";
import { nowIso } from "../util/dates.ts";
import { CmsError } from "../util/errors.ts";
import { ensureDir, listFiles, readJsonIfExists, remove, writeJson } from "../util/fs.ts";
import type { CompetitorRecord, SiteSnapshot } from "./types.ts";

export class ResearchStore {
  private readonly dir: string;

  constructor(cacheDir: string) {
    this.dir = path.join(cacheDir, "research");
  }

  private file(host: string): string {
    return path.join(this.dir, `${host.replace(/[^a-z0-9.-]/gi, "_")}.json`);
  }

  async list(): Promise<CompetitorRecord[]> {
    const files = await listFiles(this.dir, [".json"]);
    const out: CompetitorRecord[] = [];
    for (const f of files) {
      const rec = await readJsonIfExists<CompetitorRecord>(f);
      if (rec) out.push(rec);
    }
    return out.sort((a, b) => a.host.localeCompare(b.host));
  }

  async get(host: string): Promise<CompetitorRecord | undefined> {
    return readJsonIfExists<CompetitorRecord>(this.file(host));
  }

  async require(host: string): Promise<CompetitorRecord> {
    const rec = await this.get(host);
    if (!rec)
      throw new CmsError(
        "NOT_FOUND",
        `Competitor "${host}" is not tracked. Use add_competitor first.`,
      );
    return rec;
  }

  async add(url: string, meta: { name?: string; notes?: string } = {}): Promise<CompetitorRecord> {
    const host = new URL(url).host;
    const existing = await this.get(host);
    if (existing) return { ...existing, ...meta };
    const rec: CompetitorRecord = {
      host,
      url,
      name: meta.name,
      notes: meta.notes,
      addedAt: nowIso(),
      history: [],
    };
    await ensureDir(this.dir);
    await writeJson(this.file(host), rec);
    return rec;
  }

  async saveSnapshot(host: string, snapshot: SiteSnapshot): Promise<CompetitorRecord> {
    const rec = await this.require(host);
    const previous = new Set((rec.latest?.pages ?? []).map((p) => p.url));
    const newPages = rec.latest
      ? snapshot.pages
          .filter((p) => !previous.has(p.url))
          .map((p) => ({ url: p.url, title: p.title }))
      : [];
    rec.history.push({ fetchedAt: snapshot.fetchedAt, pageCount: snapshot.pages.length, newPages });
    rec.history = rec.history.slice(-30);
    rec.latest = snapshot;
    rec.name = rec.name ?? snapshot.name;
    await writeJson(this.file(host), rec);
    return rec;
  }

  async remove(host: string): Promise<void> {
    await remove(this.file(host));
  }
}
