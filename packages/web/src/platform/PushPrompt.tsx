import { useState } from "react";
import { useAuthStore } from "@thechat/client/stores/auth";
import { buttonClass, iconButtonClass } from "@thechat/client/components/ui";
import { enablePush, usePushStatus } from "./push";

const DISMISS_KEY = "thechat:push-prompt-dismissed";

function dismissedFor(userId: string) {
  try {
    return localStorage.getItem(`${DISMISS_KEY}:${userId}`) === "1";
  } catch {
    return false;
  }
}

function rememberDismissal(userId: string) {
  try {
    localStorage.setItem(`${DISMISS_KEY}:${userId}`, "1");
  } catch {
    // Storage denied: the prompt returns next session, which is acceptable.
  }
}

/**
 * Offered once per account and browser after sign-in. The browser's own
 * permission prompt only appears from the Turn on tap, never automatically.
 */
export function PushPrompt() {
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const status = usePushStatus();
  const [hiddenFor, setHiddenFor] = useState<string | null>(null);

  const askable =
    status.state === "off" &&
    typeof Notification !== "undefined" &&
    Notification.permission !== "denied";
  if (!userId || !askable || hiddenFor === userId || dismissedFor(userId)) return null;

  const dismiss = () => {
    rememberDismissal(userId);
    setHiddenFor(userId);
  };

  return (
    <div
      role="dialog"
      aria-labelledby="push-prompt-title"
      className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+0.75rem)] z-50 mx-auto flex max-w-[420px] animate-slide-up items-start gap-3 rounded-xl border border-border bg-surface/95 p-4 shadow-card backdrop-blur-2xl backdrop-saturate-150 sm:inset-x-auto sm:right-4 sm:bottom-4"
    >
      <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 size-5 shrink-0 text-accent">
        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </svg>
      <div className="min-w-0 flex-1">
        <h2 id="push-prompt-title" className="text-[0.929rem] font-semibold leading-5 text-text">
          Get notified when TheChat is closed
        </h2>
        <p className="mt-1 text-[0.857rem] leading-5 text-text-muted">
          Direct messages, mentions and agent replies. You can change this in Settings.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className={`${buttonClass("primary", "md")} max-sm:h-[44px]`}
            onClick={() => {
              void enablePush().then((enabled) => {
                if (enabled) rememberDismissal(userId);
              });
            }}
          >
            Turn on
          </button>
          <button type="button" className={`${buttonClass("ghost", "md")} max-sm:h-[44px]`} onClick={dismiss}>
            Not now
          </button>
        </div>
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        className={`${iconButtonClass("md")} max-sm:size-[44px]`}
        onClick={dismiss}
      >
        <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="size-4">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
