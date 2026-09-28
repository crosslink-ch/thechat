/**
 * Bot avatar shapes, as named by the bot-avatars library. Kept here so the API
 * can validate saved choices without loading the React library.
 */
export const BOT_AVATAR_SHAPES = [
  "clover",
  "flower",
  "triangle",
  "square",
  "blob",
  "ghost",
  "circle",
  "drop",
  "star",
  "droid",
  "mech",
  "alien",
  "hexagon",
  "cat",
  "cloud",
  "pill",
  "pebble",
  "puddle",
] as const;

export type BotAvatarShape = (typeof BOT_AVATAR_SHAPES)[number];

/**
 * Bot body colours, saturated but readable on the dark theme. 22 colours = two
 * full rows of 11 in the picker grid.
 */
export const BOT_AVATAR_COLORS = [
  "#3498DB", // blue
  "#1ABC9C", // teal
  "#2ECC71", // green
  "#9B59B6", // purple
  "#E67E22", // orange
  "#E74C3C", // red
  "#16A085", // dark teal
  "#2980B9", // dark blue
  "#8E44AD", // dark purple
  "#27AE60", // dark green
  "#D35400", // pumpkin
  "#C0392B", // dark red
  "#F39C12", // amber
  "#34495E", // slate
  "#E84393", // pink
  "#00B894", // mint
  "#0984E3", // bright blue
  "#6C5CE7", // indigo
  "#FD79A8", // light pink
  "#00CEC9", // cyan
  "#FDCB6E", // light amber
  "#636E72", // gray
] as const;

export type BotAvatarColor = (typeof BOT_AVATAR_COLORS)[number];

/** How a bot looks everywhere it appears: a shape drawn in a colour. */
export interface BotAppearance {
  shape: BotAvatarShape;
  color: BotAvatarColor;
}

export function isBotAvatarShape(value: unknown): value is BotAvatarShape {
  return (
    typeof value === "string" &&
    (BOT_AVATAR_SHAPES as readonly string[]).includes(value)
  );
}

/** Palette colour for `value` in any letter case, or null if off-palette. */
export function toBotAvatarColor(value: unknown): BotAvatarColor | null {
  if (typeof value !== "string") return null;
  const upper = value.toUpperCase();
  return BOT_AVATAR_COLORS.find((color) => color === upper) ?? null;
}

/**
 * The shape and colour a bot shows until its owner picks others. Hashing the
 * bot's user id keeps it stable across renames and lets a client that only
 * knows a message's sender still draw the right default.
 */
export function defaultBotAppearance(botUserId: string): BotAppearance {
  let hash = 0;
  for (let i = 0; i < botUserId.length; i++) {
    hash = (hash * 31 + botUserId.charCodeAt(i)) | 0;
  }
  const value = hash >>> 0;
  return {
    shape: BOT_AVATAR_SHAPES[value % BOT_AVATAR_SHAPES.length],
    color:
      BOT_AVATAR_COLORS[
        Math.floor(value / BOT_AVATAR_SHAPES.length) % BOT_AVATAR_COLORS.length
      ],
  };
}

/** A bot's saved choices, each falling back to its default when unset. */
export function resolveBotAppearance(
  botUserId: string,
  saved: { avatarShape?: string | null; avatarColor?: string | null },
): BotAppearance {
  const fallback = defaultBotAppearance(botUserId);
  return {
    shape: isBotAvatarShape(saved.avatarShape) ? saved.avatarShape : fallback.shape,
    color: toBotAvatarColor(saved.avatarColor) ?? fallback.color,
  };
}
