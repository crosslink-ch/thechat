import type { HTMLAttributes } from "react";
import type { BotAppearance } from "@thechat/shared";
import { BotFace, type BotMotion } from "./BotFace";
import { avatarColor } from "./ui";

/**
 * Initial-letter avatar: a stable colour per person. A bot with an appearance
 * draws its shape instead, unclipped so it can hop; the brand navy letter
 * stands in while the shape loads.
 */
export function Avatar({
  name,
  colorKey,
  bot = false,
  botAvatar,
  botMotion = "still",
  size = 32,
  className = "size-8 text-[0.857rem]",
  children,
  style,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & {
  name: string;
  /** Stable identity for the colour (user id); falls back to the name. */
  colorKey?: string;
  bot?: boolean;
  /** The bot's shape and colour; without it a bot shows the navy letter. */
  botAvatar?: BotAppearance | null;
  botMotion?: BotMotion;
  /** Pixel size of the bot shape; match it to the `size-*` class. */
  size?: number;
}) {
  const initial = name.charAt(0).toUpperCase();

  if (bot && botAvatar) {
    return (
      <span
        {...rest}
        className={`relative flex shrink-0 items-center justify-center font-semibold text-white ${className}`}
        style={style}
      >
        <BotFace
          appearance={botAvatar}
          size={size}
          motion={botMotion}
          fallback={
            <span className="flex size-full items-center justify-center rounded-full bg-accent-hover">
              {initial}
            </span>
          }
        />
        {children}
      </span>
    );
  }

  return (
    <span
      {...rest}
      className={`relative flex shrink-0 items-center justify-center rounded-full font-semibold text-white ${bot ? "bg-accent-hover" : ""} ${className}`}
      style={bot ? style : { ...style, backgroundColor: avatarColor(colorKey || name) }}
    >
      {initial}
      {children}
    </span>
  );
}
