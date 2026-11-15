import emojiData from "emoji-datasource/emoji.json";

/** One emoji from emoji-datasource, by its short names. */
export interface EmojiEntry {
  /** The unicode character(s). */
  emoji: string;
  /** The first short name, e.g. "smile". */
  shortName: string;
  shortNames: string[];
}

interface EmojiDataEntry {
  unified: string;
  short_name: string;
  short_names: string[];
  sort_order: number;
  obsoleted_by?: string;
}

const toEmoji = (unified: string) =>
  String.fromCodePoint(...unified.split("-").map((hex) => parseInt(hex, 16)));

const ENTRIES: EmojiEntry[] = (emojiData as EmojiDataEntry[])
  .filter((entry) => !entry.obsoleted_by)
  .sort((a, b) => a.sort_order - b.sort_order)
  .map((entry) => ({
    emoji: toEmoji(entry.unified),
    shortName: entry.short_name,
    shortNames: entry.short_names,
  }));

const BY_NAME = new Map<string, EmojiEntry>();
for (const entry of ENTRIES) {
  for (const name of entry.shortNames) if (!BY_NAME.has(name)) BY_NAME.set(name, entry);
}

/** The emoji for an exact short name ("smile" -> 😄), if any. */
export function emojiForShortName(name: string): EmojiEntry | undefined {
  return BY_NAME.get(name.toLowerCase());
}

/**
 * Best matches for a query: exact short name, then names that start with
 * the query, then names with a word ("_"-separated) that starts with it,
 * then any name containing it. Ties keep emoji-datasource's sort order.
 */
export function searchEmoji(query: string, limit = 8): EmojiEntry[] {
  const q = query.toLowerCase();
  if (!q) return [];
  const scored: { entry: EmojiEntry; rank: number; order: number }[] = [];
  ENTRIES.forEach((entry, order) => {
    let rank = Infinity;
    for (const name of entry.shortNames) {
      if (name === q) rank = Math.min(rank, 0);
      else if (name.startsWith(q)) rank = Math.min(rank, 1);
      else if (name.split("_").some((word) => word.startsWith(q))) rank = Math.min(rank, 2);
      else if (name.includes(q)) rank = Math.min(rank, 3);
    }
    if (rank !== Infinity) scored.push({ entry, rank, order });
  });
  return scored
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, limit)
    .map((item) => item.entry);
}
