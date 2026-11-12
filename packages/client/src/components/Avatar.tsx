import { useState, type HTMLAttributes } from "react";
import type { BotAppearance } from "@thechat/shared";
import { BotFace, type BotMotion } from "./BotFace";
import { avatarColor } from "./ui";

/**
 * A person's profile picture, or their initial letter on a stable colour when
 * they have none or it fails to load. A bot with an appearance draws its shape
 * instead, unclipped so it can hop; the brand navy letter stands in while the
 * shape loads.
 */
export function Avatar({
  name,
  colorKey,
  picture,
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
  /** The person's profile picture. Bots draw their shape instead. */
  picture?: string | null;
  bot?: boolean;
  /** The bot's shape and colour; without it a bot shows the navy letter. */
  botAvatar?: BotAppearance | null;
  botMotion?: BotMotion;
  /** Pixel size of the bot shape; match it to the `size-*` class. */
  size?: number;
}) {
  // Remember which picture failed, so a replacement gets its own attempt.
  const [failedPicture, setFailedPicture] = useState<string | null>(null);
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

  if (!bot && picture && picture !== failedPicture) {
    return (
      <span
        {...rest}
        className={`relative flex shrink-0 items-center justify-center rounded-full ${className}`}
        style={style}
      >
        {/* The name is always shown beside the avatar, so the picture is
            decorative. The image is rounded itself: children such as the
            online dot overlap the circle's edge and must not be clipped. */}
        <img
          src={picture}
          alt=""
          draggable={false}
          referrerPolicy="no-referrer"
          className="size-full rounded-full object-cover"
          onError={() => setFailedPicture(picture)}
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
