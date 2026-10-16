import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { SERVER_VERSION } from "../core/version.ts";

const require = createRequire(import.meta.url);

let bridgeSource: string | undefined;

/** The MCP Apps browser bridge, inlined so the preview view is a single self-contained resource. */
async function loadBridge(): Promise<string> {
  if (bridgeSource) return bridgeSource;
  const file = require.resolve("@modelcontextprotocol/ext-apps/app-with-deps");
  const raw = await readFile(file, "utf8");
  // The bundle ends with `export{a as X,b as Y,...}`; turn it into a global we can reach from the page.
  const m = raw.match(/export\s*\{([^}]*)\}\s*;?\s*$/);
  if (!m) throw new Error("Unexpected MCP Apps bundle shape");
  const pairs = m[1]!
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [local, exported] = p.split(/\s+as\s+/).map((s) => s.trim());
      return `${JSON.stringify(exported ?? local)}: ${local}`;
    });
  bridgeSource = `${raw.slice(0, m.index)}\nwindow.__mcpApps = {${pairs.join(",")}};`;
  return bridgeSource;
}

export const PREVIEW_APP_URI = "ui://agentcms/preview.html";

/**
 * The interactive preview rendered inside hosts that support MCP Apps. It receives the
 * preview_page result, shows the audit summary and renders the self-contained page HTML in a
 * shadow root so the theme's inlined styles apply without leaking into the host.
 */
export async function previewAppHtml(): Promise<string> {
  const bridge = await loadBridge();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agentcms preview</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 0; display: flex; flex-direction: column; height: 100vh; }
  .bar { display: flex; gap: .75rem; align-items: center; padding: .5rem .75rem; border-bottom: 1px solid rgba(128,128,128,.35); font-size: .85rem; flex-wrap: wrap; }
  .bar code { font-size: .8rem; }
  .score { font-weight: 600; padding: .1rem .5rem; border-radius: 999px; background: rgba(128,128,128,.2); }
  .score.good { background: #d8f5e3; color: #0a5a2a; } .score.warn { background: #fff1c7; color: #7a4d00; } .score.bad { background: #ffd9d9; color: #8a0000; }
  .bar button { font: inherit; padding: .2rem .6rem; border-radius: .4rem; border: 1px solid rgba(128,128,128,.5); background: transparent; color: inherit; cursor: pointer; }
  .bar button[aria-pressed="true"] { background: rgba(128,128,128,.25); }
  .stage { flex: 1; overflow: auto; background: #e9ecef; padding: 1rem; }
  .frame { margin: 0 auto; background: #fff; box-shadow: 0 2px 12px rgba(0,0,0,.15); transition: width .2s; }
  .frame.desktop { width: 100%; max-width: 1280px; } .frame.mobile { width: 390px; }
  .issues { font-size: .8rem; padding: .25rem .75rem; max-height: 6rem; overflow: auto; border-bottom: 1px solid rgba(128,128,128,.35); }
  .issues li { margin: .1rem 0; }
  .empty { padding: 2rem; text-align: center; opacity: .7; }
</style>
</head>
<body>
  <div class="bar">
    <strong>agentcms preview</strong>
    <code id="route">waiting for preview_page…</code>
    <span id="score" class="score" hidden></span>
    <span style="margin-left:auto"></span>
    <button id="desktop" aria-pressed="true">Desktop</button>
    <button id="mobile" aria-pressed="false">Mobile</button>
  </div>
  <ul class="issues" id="issues" hidden></ul>
  <div class="stage"><div id="frame" class="frame desktop"><div class="empty">The rendered page appears here once preview_page returns.</div></div></div>
  <script type="module">
${bridge}
const { App } = window.__mcpApps;
const frame = document.getElementById("frame");
const route = document.getElementById("route");
const score = document.getElementById("score");
const issues = document.getElementById("issues");
function show(sc) {
  if (!sc || typeof sc.html !== "string") return;
  route.textContent = sc.url || sc.route?.path || "";
  const s = sc.audit?.score;
  if (typeof s === "number") { score.hidden = false; score.textContent = "Page " + s; score.className = "score " + (s >= 80 ? "good" : s >= 60 ? "warn" : "bad"); }
  const failed = sc.audit?.failed || [];
  issues.innerHTML = "";
  issues.hidden = failed.length === 0;
  for (const f of failed.slice(0, 6)) { const li = document.createElement("li"); li.textContent = (f.severity || "") + ": " + f.message; issues.appendChild(li); }
  const doc = new DOMParser().parseFromString(sc.html, "text/html");
  const root = frame.shadowRoot || frame.attachShadow({ mode: "open" });
  root.innerHTML = "";
  for (const style of doc.querySelectorAll("style")) root.appendChild(style.cloneNode(true));
  const body = document.createElement("div");
  body.innerHTML = doc.body.innerHTML;
  for (const a of body.querySelectorAll("a[href]")) a.setAttribute("target", "_blank");
  root.appendChild(body);
}
for (const id of ["desktop", "mobile"]) {
  document.getElementById(id).addEventListener("click", () => {
    frame.className = "frame " + id;
    document.getElementById("desktop").setAttribute("aria-pressed", String(id === "desktop"));
    document.getElementById("mobile").setAttribute("aria-pressed", String(id === "mobile"));
  });
}
const app = new App({ name: "agentcms-preview", version: ${JSON.stringify(SERVER_VERSION)} });
app.ontoolresult = (params) => show(params.structuredContent);
app.connect().catch((err) => { route.textContent = "could not connect to the host: " + err.message; });
  </script>
</body>
</html>`;
}
