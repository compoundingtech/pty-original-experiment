import * as os from "node:os";
import { isReservedTagKey } from "./tags.ts";

export interface SessionPresentation {
  name: string;
  displayName?: string;
  cwd?: string;
  displayCommand?: string;
  tags?: Record<string, string>;
  createdAt?: string;
  ephemeral?: boolean;
}

export const renderTags = (tags: Record<string, string> | undefined, showAll: boolean): string => {
  if (!tags) return "";
  const entries = Object.entries(tags).filter(([k]) => showAll || !isReservedTagKey(k));
  return entries.length > 0 ? " " + entries.map(([k, v]) => `#${k}=${v}`).join(" ") : "";
};

export const renderLabel = (name: string, displayName: string | undefined, boldCode: string): string =>
  displayName
    ? `${boldCode}${displayName}\x1b[0m \x1b[2m(${name})\x1b[0m`
    : `${boldCode}${name}\x1b[0m`;

export const strategyMarker = (tags?: Record<string, string>): string => {
  if (!tags) return "";
  if (tags["strategy.status"] === "flapping") return " \x1b[31m[flapping]\x1b[0m";
  if (tags.strategy === "permanent") return " \x1b[33m[permanent]\x1b[0m";
  return "";
};

export const shortPath = (p: string): string => {
  const home = os.homedir();
  if (p === home) return "~";
  if (p.startsWith(home + "/")) return "~" + p.slice(home.length);
  return p;
};

export const sessionSummary = (s: SessionPresentation): string =>
  `  ${renderLabel(s.name, s.displayName, "\x1b[1m")}${strategyMarker(s.tags)}${renderTags(s.tags, false)} — ${s.cwd ? shortPath(s.cwd) : ""} — \x1b[2m${s.displayCommand ?? ""}\x1b[0m`;

export const plainLabel = (s: SessionPresentation): string =>
  s.displayName ? `${s.displayName} (${s.name})` : s.name;
