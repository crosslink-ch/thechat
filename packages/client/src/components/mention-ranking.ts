import type { BotAppearance, BotKind } from "@thechat/shared";
import { botAppearanceFor } from "../lib/bot-appearance";
import type { MentionUser } from "./MentionList";

/** The @ menu's sections, in order. */
export const MENTION_SECTIONS = [
  { type: "human", title: "People" },
  { type: "bot", title: "Agents" },
] as const;

const MAX_PER_SECTION = 8;

/**
 * Rank candidates for the @ menu: names that start with the query first,
 * then names with a word that starts with it, then any other match. People
 * come before agents (the menu shows them in two sections). Ties keep the
 * given order, so callers can boost conversation participants.
 */
export function rankMentionCandidates(candidates: readonly MentionUser[], query: string) {
  const q = query.trim().toLocaleLowerCase();
  const scored: { user: MentionUser; rank: number; index: number }[] = [];
  candidates.forEach((user, index) => {
    const label = user.label.toLocaleLowerCase();
    let rank: number;
    if (!q) rank = 0;
    else if (label.startsWith(q)) rank = 0;
    else if (label.split(/[\s._-]+/).some((word) => word.startsWith(q))) rank = 1;
    else if (label.includes(q)) rank = 2;
    else return;
    scored.push({ user, rank, index });
  });
  const ordered: MentionUser[] = [];
  for (const section of MENTION_SECTIONS) {
    ordered.push(
      ...scored
        .filter(({ user }) => user.type === section.type)
        .sort((a, b) => a.rank - b.rank || a.index - b.index)
        .slice(0, MAX_PER_SECTION)
        .map(({ user }) => user),
    );
  }
  return ordered;
}

/**
 * A short, stable hint that tells equal names apart: the candidate's own
 * detail (e.g. an agent's kind) when it has one, else the start of the ID.
 * Only shown when another candidate has the same name. Emails stay hidden.
 */
export function mentionDiscriminators(items: readonly MentionUser[]) {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = item.label.trim().toLocaleLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const hints = new Map<string, string>();
  for (const item of items) {
    if ((counts.get(item.label.trim().toLocaleLowerCase()) ?? 0) < 2) continue;
    const shortId = `#${item.id.replace(/-/g, "").slice(0, 4)}`;
    hints.set(item.id, item.detail ? `${item.detail} · ${shortId}` : shortId);
  }
  return hints;
}

/** A workspace member as an @ menu candidate. */
export function mentionCandidate(member: {
  userId: string;
  user: { name: string; type: "human" | "bot"; avatar?: string | null };
  bot?: { kind: BotKind; avatar?: BotAppearance } | null;
}): MentionUser {
  const bot = member.user.type === "bot";
  return {
    id: member.userId,
    label: member.user.name,
    type: member.user.type,
    picture: member.user.avatar ?? null,
    ...(bot
      ? {
          botAvatar: botAppearanceFor(member.userId, member.bot?.avatar),
          detail: member.bot?.kind === "hermes" ? "Hermes" : member.bot ? "Webhook" : undefined,
        }
      : {}),
  };
}
