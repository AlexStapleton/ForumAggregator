// Minimal robots.txt evaluator (RFC 9309): picks the most specific user-agent group,
// then the longest matching rule wins; on a tie, Allow wins. Supports * and $ in paths.

interface Rule {
  allow: boolean;
  pattern: string;
}

interface Group {
  agents: string[];
  rules: Rule[];
}

function parse(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | undefined;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === "user-agent") {
      // Consecutive User-agent lines share one group.
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === "allow" || key === "disallow") && current) {
      lastWasAgent = false;
      // An empty Disallow means "allow everything" and adds no rule.
      if (value) current.rules.push({ allow: key === "allow", pattern: value });
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

/** The product token used for group matching, e.g. "ForumAggregator" from a full UA string. */
export function productToken(userAgent: string): string {
  const m = /([A-Za-z][A-Za-z0-9_-]*)\/[\d.]+/.exec(userAgent.replace(/^Mozilla\/[\d.]+\s*/, ""));
  return (m?.[1] ?? userAgent).toLowerCase();
}

export interface RobotsVerdict {
  allowed: boolean;
  /** The user-agent group that applied ("*" or a specific name), if any. */
  group?: string;
  rule?: string;
}

export function checkRobots(robotsTxt: string, userAgent: string, path: string): RobotsVerdict {
  const token = productToken(userAgent);
  const groups = parse(robotsTxt);
  // Most specific matching group: an agent name contained in our token; else "*".
  let chosen: Group | undefined;
  let chosenName: string | undefined;
  for (const g of groups) {
    for (const a of g.agents) {
      if (a !== "*" && token.includes(a) && (!chosenName || a.length > chosenName.length)) {
        chosen = g;
        chosenName = a;
      }
    }
  }
  if (!chosen) {
    const star = groups.filter((g) => g.agents.includes("*"));
    if (star.length) {
      chosen = { agents: ["*"], rules: star.flatMap((g) => g.rules) };
      chosenName = "*";
    }
  }
  if (!chosen) return { allowed: true };

  let best: Rule | undefined;
  for (const rule of chosen.rules) {
    if (!patternToRegex(rule.pattern).test(path)) continue;
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) {
      best = rule;
    }
  }
  return {
    allowed: best ? best.allow : true,
    group: chosenName,
    rule: best ? `${best.allow ? "Allow" : "Disallow"}: ${best.pattern}` : undefined,
  };
}
