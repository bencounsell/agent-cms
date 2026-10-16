import { gunzipSync } from "node:zlib";
import { CmsError } from "../util/errors.ts";
import { log } from "../util/log.ts";

export interface FetchResult {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  text: string;
}

export interface FetcherOptions {
  userAgent: string;
  delayMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  maxBytes?: number;
}

/** Polite HTTP client: identifies itself, waits between requests, caps body size. */
export class Fetcher {
  private readonly ua: string;
  private readonly delayMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly maxBytes: number;
  private last = 0;
  requests = 0;

  constructor(opts: FetcherOptions) {
    this.ua = opts.userAgent;
    this.delayMs = opts.delayMs ?? 600;
    this.timeoutMs = opts.timeoutMs ?? 15000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxBytes = opts.maxBytes ?? 3_000_000;
  }

  async get(url: string): Promise<FetchResult> {
    const wait = this.last + this.delayMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.last = Date.now();
    this.requests++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        headers: {
          "user-agent": this.ua,
          accept:
            "text/html,application/xhtml+xml,application/xml,text/xml,text/plain;q=0.9,*/*;q=0.5",
        },
        redirect: "follow",
        signal: controller.signal,
      });
      const contentType = res.headers.get("content-type") ?? "";
      const buf = Buffer.from(await res.arrayBuffer());
      let body = buf;
      if (url.endsWith(".gz") || contentType.includes("gzip")) {
        try {
          body = gunzipSync(buf);
        } catch {
          // not actually gzipped
        }
      }
      const text = body.subarray(0, this.maxBytes).toString("utf8");
      return { url, finalUrl: res.url || url, status: res.status, contentType, text };
    } catch (err) {
      log.debug("fetch failed", url, err);
      throw new CmsError("NETWORK", `Failed to fetch ${url}: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
