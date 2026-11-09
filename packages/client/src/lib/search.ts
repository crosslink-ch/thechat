import { parseMessageSearchTerms, scoreSearchMatch, type SearchDestination } from "@thechat/shared";

export type DestinationKind = SearchDestination["kind"];

/** What the quick switcher shows, chosen by an optional leading character. */
export type PaletteMode = "all" | "people" | "channels" | "tasks" | "messages" | "commands";

const PREFIX_MODES: Record<string, PaletteMode> = {
  ">": "commands",
  "@": "people",
  "#": "channels",
  "?": "messages",
};

export const PALETTE_MODE_PREFIX: Partial<Record<PaletteMode, string>> = {
  people: "@",
  channels: "#",
  messages: "?",
  commands: ">",
};

export function parsePaletteQuery(raw: string): { mode: PaletteMode; text: string } {
  const value = raw.trimStart();
  const mode = PREFIX_MODES[value.charAt(0)];
  if (mode) return { mode, text: value.slice(1).trim() };
  return { mode: "all", text: value.trim() };
}

/** True when `text` is long enough for the server's message search. */
export function canSearchMessages(text: string) {
  return parseMessageSearchTerms(text).join("").length >= 2;
}

export function destinationName(destination: SearchDestination) {
  return destination.kind === "task" ? destination.title : destination.name;
}

/** Stable identity for lists and selection. */
export function destinationKey(destination: SearchDestination) {
  switch (destination.kind) {
    case "channel":
      return `channel:${destination.conversationId}`;
    case "person":
      return `person:${destination.workspaceId}:${destination.userId}`;
    case "task":
      return `task:${destination.threadId}`;
  }
}

/** The place a destination opens, in the same form recent visits are kept. */
export function locationKey(conversationId: string, threadId: string | null | undefined) {
  return threadId ? `${conversationId}:${threadId}` : conversationId;
}

export function destinationLocationKey(destination: SearchDestination) {
  switch (destination.kind) {
    case "channel":
      return locationKey(destination.conversationId, null);
    case "person":
      return destination.conversationId ? locationKey(destination.conversationId, null) : null;
    case "task":
      return locationKey(destination.conversationId, destination.threadId);
  }
}

export interface RankOptions {
  kinds?: ReadonlySet<DestinationKind>;
  /** Location keys, most recent first. */
  recent?: readonly string[];
  activeWorkspaceId?: string | null;
  limit?: number;
}

/**
 * Destinations for what the user typed, best first. An empty query lists
 * recent places. Recent and current-workspace places win ties, never over a
 * better match: an exact name always beats a recently visited prefix match.
 */
export function rankDestinations(
  destinations: readonly SearchDestination[],
  text: string,
  options: RankOptions = {},
): SearchDestination[] {
  const limit = options.limit ?? 8;
  const recentIndex = new Map((options.recent ?? []).map((key, index) => [key, index]));
  const allowed = (destination: SearchDestination) => !options.kinds || options.kinds.has(destination.kind);

  if (!text) {
    const byLocation = new Map<string, SearchDestination>();
    for (const destination of destinations) {
      const key = destinationLocationKey(destination);
      if (key && allowed(destination) && !byLocation.has(key)) byLocation.set(key, destination);
    }
    return (options.recent ?? [])
      .map((key) => byLocation.get(key))
      .filter((destination): destination is SearchDestination => Boolean(destination))
      .slice(0, limit);
  }

  const scored: { destination: SearchDestination; score: number; name: string }[] = [];
  for (const destination of destinations) {
    if (!allowed(destination)) continue;
    const name = destinationName(destination);
    const match = scoreSearchMatch(text, name);
    if (match === null) continue;
    const key = destinationLocationKey(destination);
    const recent = key ? recentIndex.get(key) : undefined;
    let score = match;
    if (recent !== undefined) score += Math.max(1, 10 - recent);
    if (destination.workspaceId === options.activeWorkspaceId) score += 2;
    // A person or channel named like a task title is the likelier target.
    if (destination.kind !== "task") score += 1;
    scored.push({ destination, score, name });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((entry) => entry.destination);
}

/**
 * Every destination of the given kinds, for a filter with nothing typed yet:
 * recent places first, then the current workspace, then by name.
 */
export function listDestinations(
  destinations: readonly SearchDestination[],
  options: RankOptions = {},
): SearchDestination[] {
  const limit = options.limit ?? 50;
  const recentIndex = new Map((options.recent ?? []).map((key, index) => [key, index]));
  const order = (destination: SearchDestination) => {
    const key = destinationLocationKey(destination);
    const recent = key ? recentIndex.get(key) : undefined;
    return recent ?? (destination.workspaceId === options.activeWorkspaceId ? 1_000 : 2_000);
  };
  return destinations
    .filter((destination) => !options.kinds || options.kinds.has(destination.kind))
    .map((destination) => ({ destination, order: order(destination), name: destinationName(destination) }))
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((entry) => entry.destination);
}

/** Split text into plain and matching pieces, for highlighting search terms. */
export function highlightParts(text: string, query: string): { text: string; match: boolean }[] {
  const terms = parseMessageSearchTerms(query)
    .map((term) => term.toLowerCase())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (terms.length === 0 || !text) return [{ text, match: false }];
  const lower = text.toLowerCase();
  const parts: { text: string; match: boolean }[] = [];
  let index = 0;
  let plainStart = 0;
  while (index < text.length) {
    const term = terms.find((candidate) => lower.startsWith(candidate, index));
    if (!term) {
      index += 1;
      continue;
    }
    if (index > plainStart) parts.push({ text: text.slice(plainStart, index), match: false });
    parts.push({ text: text.slice(index, index + term.length), match: true });
    index += term.length;
    plainStart = index;
  }
  if (plainStart < text.length) parts.push({ text: text.slice(plainStart), match: false });
  return parts;
}

/** "14:02" today, "Mon 14:02" this week, "3 Oct" this year, else "3 Oct 2025". */
export function formatSearchTime(iso: string, now = new Date()) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (date.getTime() >= startOfToday) return time;
  if (date.getTime() >= startOfToday - 6 * 86_400_000) {
    return `${date.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  }
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}
