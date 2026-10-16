import path from "node:path";
import type { AssetFile } from "../templates/pages.ts";
import { log } from "../util/log.ts";

export interface SelfContainedOptions {
  siteUrl: string;
  assets: AssetFile[];
  assetMap: Record<string, string>;
}

/**
 * Turn a rendered page into a single document a client can show on its own: stylesheets inlined,
 * scripts removed, root-relative links and images made absolute against the site URL.
 */
export function makeSelfContained(html: string, opts: SelfContainedOptions): string {
  const base = opts.siteUrl.replace(/\/+$/, "");
  const byPublicPath = new Map(opts.assets.map((a) => [opts.assetMap[a.name] ?? `/${a.rel}`, a]));
  let out = html.replace(/<link\s+rel="stylesheet"\s+href="([^"]+)"\s*\/?>/g, (m, href: string) => {
    const asset = byPublicPath.get(href);
    return asset
      ? `<style data-inlined="${path.basename(asset.rel)}">${asset.content.toString("utf8")}</style>`
      : m;
  });
  out = out.replace(/<script\b[^>]*\ssrc="[^"]*"[^>]*>\s*<\/script>/g, "");
  out = out.replace(
    /\s(href|src|action)="\/(?!\/)([^"]*)"/g,
    (_m, attr: string, rest: string) => ` ${attr}="${base}/${rest}"`,
  );
  return out;
}

export interface ScreenshotOptions {
  width: number;
  height: number;
  fullPage?: boolean;
}

export type ScreenshotResult =
  | { ok: true; png: Buffer; width: number; height: number }
  | { ok: false; reason: string; hint: string };

const HINT =
  "Install the optional dependency with `npm i playwright-core` and a browser with `npx playwright install chromium` (or set AGENTCMS_CHROMIUM_PATH to an existing Chromium binary).";

/** Render HTML in headless Chromium through the optional playwright-core dependency. */
export async function screenshotHtml(
  html: string,
  opts: ScreenshotOptions,
): Promise<ScreenshotResult> {
  let pw: typeof import("playwright-core");
  try {
    pw = await import("playwright-core");
  } catch {
    return { ok: false, reason: "playwright-core is not installed", hint: HINT };
  }
  let browser: Awaited<ReturnType<typeof pw.chromium.launch>> | undefined;
  try {
    browser = await pw.chromium.launch({
      headless: true,
      executablePath: process.env.AGENTCMS_CHROMIUM_PATH || undefined,
    });
    const page = await browser.newPage({
      viewport: { width: opts.width, height: opts.height },
      deviceScaleFactor: 1,
    });
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(150);
    const png = await page.screenshot({ type: "png", fullPage: opts.fullPage ?? false });
    return { ok: true, png: Buffer.from(png), width: opts.width, height: opts.height };
  } catch (err) {
    log.debug("screenshot failed", err);
    return {
      ok: false,
      reason: (err as Error).message.split("\n")[0] ?? "screenshot failed",
      hint: HINT,
    };
  } finally {
    await browser?.close().catch(() => {});
  }
}

export const VIEWPORTS = {
  desktop: { width: 1280, height: 900 },
  mobile: { width: 390, height: 844 },
} as const;
export type ViewportName = keyof typeof VIEWPORTS;
