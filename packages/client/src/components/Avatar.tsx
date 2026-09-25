import type { HTMLAttributes } from "react";
import { avatarColor } from "./ui";

/** Initial-letter avatar: a stable colour per person, the brand navy for bots. */
export function Avatar({
  name,
  colorKey,
  bot = false,
  className = "size-8 text-[0.857rem]",
  children,
  style,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & {
  name: string;
  /** Stable identity for the colour (user id); falls back to the name. */
  colorKey?: string;
  bot?: boolean;
}) {
  return (
    <span
      {...rest}
      className={`relative flex shrink-0 items-center justify-center rounded-full font-semibold text-white ${bot ? "bg-accent-hover" : ""} ${className}`}
      style={bot ? style : { ...style, backgroundColor: avatarColor(colorKey || name) }}
    >
      {name.charAt(0).toUpperCase()}
      {children}
    </span>
  );
}
