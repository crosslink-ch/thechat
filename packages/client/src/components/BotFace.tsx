import { lazy, Suspense, type ReactNode } from "react";
import type { BotAppearance } from "@thechat/shared";

// Loaded once a bot is on screen, so screens without bots start no slower.
const BotAvatar = lazy(() => import("bot-avatars"));

/**
 * `still`: frozen, for lists and message rows. `idle`: looks around and blinks,
 * for a bot waiting on the user. `live`: idles and follows the pointer (the
 * bot's own page). `working`: hops while the bot runs. `sleeping`: the bot
 * cannot act (its API key is revoked).
 */
export type BotMotion = "still" | "idle" | "live" | "working" | "sleeping";

/** An animated bot-avatars body. Decorative: the bot's name sits beside it. */
export function BotFace({
  appearance,
  size,
  motion = "still",
  fallback = null,
}: {
  appearance: BotAppearance;
  /** Rendered size in CSS px; hops and flips draw past it, unclipped. */
  size: number;
  motion?: BotMotion;
  /** Shown while the library loads. */
  fallback?: ReactNode;
}) {
  // Minimal is deliberately outside the animated library: no face, pointer
  // interaction, idle loop or motion-state remounting, even while working.
  if (appearance.shape === "minimal") {
    return (
      <svg
        data-bot-minimal="true"
        aria-hidden="true"
        focusable="false"
        width={size}
        height={size}
        viewBox="0 0 32 32"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        className="shrink-0"
        style={{ color: appearance.color }}
      >
        <rect x={4} y={4} width={24} height={24} rx={6} />
        <path d="M16 10 22 16 16 22 10 16Z" />
      </svg>
    );
  }

  return (
    <Suspense fallback={fallback}>
      {/* A new instance per motion: pausing freezes the current frame, so a
          bot stopped mid-hop would keep that pose. A fresh bot starts at rest. */}
      <BotAvatar
        key={motion}
        type={appearance.shape}
        color={appearance.color}
        size={size}
        state={
          motion === "working"
            ? "working"
            : motion === "sleeping"
              ? "sleeping"
              : "default"
        }
        paused={motion === "still" || motion === "sleeping"}
        interactive={motion === "live"}
        theme="dark"
        aria-hidden
      />
    </Suspense>
  );
}
