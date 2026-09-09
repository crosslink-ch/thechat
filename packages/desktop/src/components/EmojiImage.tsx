import emojiData from "emoji-datasource/emoji.json";
import twitterEmojiSheet from "emoji-datasource/img/twitter/sheets/32.png";
import { useSyncExternalStore } from "react";

// Twemoji graphics are licensed under CC-BY 4.0:
// https://github.com/jdecked/twemoji/blob/main/LICENSE-GRAPHICS
const SOURCE_EMOJI_SIZE = 32;
const CELL_PADDING = 1;
const CELL_SIZE = SOURCE_EMOJI_SIZE + CELL_PADDING * 2;

interface EmojiPosition {
  unified: string;
  non_qualified?: string | null;
  sheet_x: number;
  sheet_y: number;
  has_img_twitter?: boolean;
}

interface EmojiDataEntry extends EmojiPosition {
  non_qualified: string | null;
  skin_variations?: Record<string, EmojiPosition>;
}

type SpriteStatus = "loading" | "ready" | "failed";

const positions = new Map<string, EmojiPosition>();
const spriteListeners = new Set<() => void>();
let maxSheetCoordinate = 0;
let spriteStatus: SpriteStatus = "loading";

for (const entry of emojiData as EmojiDataEntry[]) {
  addPosition(entry.unified, entry);
  if (entry.non_qualified) {
    addPosition(entry.non_qualified, entry);
  }
  for (const variation of Object.values(entry.skin_variations ?? {})) {
    addPosition(variation.unified, variation);
    if (variation.non_qualified) {
      addPosition(variation.non_qualified, variation);
    }
  }
}

const sheetCellsPerAxis = maxSheetCoordinate + 1;
const sourceSheetSize = sheetCellsPerAxis * CELL_SIZE;

interface EmojiImageProps {
  emoji: string;
  size?: number;
  className?: string;
}

export function EmojiImage({
  emoji,
  size = 20,
  className,
}: EmojiImageProps) {
  const unified = emojiToUnified(emoji);
  const position = positions.get(unified);
  const status = useSyncExternalStore(
    subscribeToSpriteStatus,
    readSpriteStatus,
    readSpriteStatus,
  );

  if (!position || status !== "ready") {
    return (
      <span
        className={className}
        {...(position && status === "loading"
          ? { "data-emoji-loading": "" }
          : { "data-emoji-fallback": "" })}
        aria-hidden="true"
        style={{
          display: "inline-flex",
          width: size,
          height: size,
          alignItems: "center",
          justifyContent: "center",
          fontSize: size,
          lineHeight: 1,
          flex: "0 0 auto",
        }}
      >
        {emoji}
        {position && status === "loading" && (
          <img
            src={twitterEmojiSheet}
            alt=""
            aria-hidden="true"
            hidden
            data-emoji-sprite-loader
            onLoad={() => setSpriteStatus("ready")}
            onError={() => setSpriteStatus("failed")}
          />
        )}
      </span>
    );
  }

  const scale = size / SOURCE_EMOJI_SIZE;
  const sheetSize = sourceSheetSize * scale;
  const x = -(position.sheet_x * CELL_SIZE + CELL_PADDING) * scale;
  const y = -(position.sheet_y * CELL_SIZE + CELL_PADDING) * scale;

  return (
    <span
      className={className}
      data-emoji-image={position.unified.toLowerCase()}
      aria-hidden="true"
      style={{
        display: "inline-block",
        width: size,
        height: size,
        flex: "0 0 auto",
        verticalAlign: "-0.125em",
        backgroundImage: `url(${twitterEmojiSheet})`,
        backgroundRepeat: "no-repeat",
        backgroundSize: `${sheetSize}px ${sheetSize}px`,
        backgroundPosition: `${x}px ${y}px`,
      }}
    />
  );
}

function addPosition(unified: string, position: EmojiPosition) {
  if (position.has_img_twitter === false) return;
  positions.set(unified.toUpperCase(), position);
  maxSheetCoordinate = Math.max(
    maxSheetCoordinate,
    position.sheet_x,
    position.sheet_y,
  );
}

function emojiToUnified(emoji: string) {
  return Array.from(emoji.normalize("NFC"), (character) =>
    character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0"),
  ).join("-");
}

function subscribeToSpriteStatus(listener: () => void) {
  spriteListeners.add(listener);
  return () => spriteListeners.delete(listener);
}

function readSpriteStatus() {
  return spriteStatus;
}

function setSpriteStatus(next: SpriteStatus) {
  if (spriteStatus === next) return;
  spriteStatus = next;
  for (const listener of spriteListeners) listener();
}
