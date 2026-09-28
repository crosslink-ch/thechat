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
