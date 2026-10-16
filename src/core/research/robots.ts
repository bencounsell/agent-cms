export interface RobotsRules {
  groups: { agents: string[]; allow: string[]; disallow: string[] }[];
  sitemaps: string[];
}

export function parseRobots(text: string): RobotsRules {
  const groups: RobotsRules["groups"] = [];
  const sitemaps: string[] = [];
  let current: RobotsRules["groups"][number] | undefined;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === "allow") current.allow.push(value);
    if (field === "disallow") current.disallow.push(value);
  }
  return { groups, sitemaps };
}

function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}${pattern.endsWith("$") ? "" : ""}`);
}

/** Longest-match semantics: the most specific allow/disallow rule wins; allow wins ties. */
export function isAllowed(rules: RobotsRules, userAgent: string, pathname: string): boolean {
  const token = userAgent.toLowerCase().split("/")[0]!;
  const group =
    rules.groups.find((g) => g.agents.some((a) => a !== "*" && token.includes(a))) ??
    rules.groups.find((g) => g.agents.includes("*"));
  if (!group) return true;
  let best: { allow: boolean; len: number } | undefined;
  for (const rule of group.allow) {
    if (
      rule &&
      patternToRegex(rule.replace(/\$$/, "")).test(pathname) &&
      (!best || rule.length >= best.len)
    ) {
      best = { allow: true, len: rule.length };
    }
  }
  for (const rule of group.disallow) {
    if (
      rule &&
      patternToRegex(rule.replace(/\$$/, "")).test(pathname) &&
      (!best || rule.length > best.len)
    ) {
      best = { allow: false, len: rule.length };
    }
  }
  return best ? best.allow : true;
}
