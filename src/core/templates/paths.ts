import { fileURLToPath } from "node:url";

/** The theme shipped with the package. Resolves from both src/ and dist/ (same depth). */
export const BUNDLED_THEME_DIR = fileURLToPath(new URL("../../../theme/default/", import.meta.url));

export const TEMPLATE_KINDS = ["layout", "page", "partial", "asset"] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];

export function templateKind(relPath: string): TemplateKind | undefined {
  if (relPath.startsWith("layouts/")) return "layout";
  if (relPath.startsWith("pages/")) return "page";
  if (relPath.startsWith("partials/")) return "partial";
  if (relPath.startsWith("assets/")) return "asset";
  return undefined;
}
