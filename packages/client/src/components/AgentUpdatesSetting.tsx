import { useEffect, useId, useState } from "react";
import { useNotificationPreferencesStore } from "../stores/notification-preferences";
import { settingsHint, settingsLabel, settingsRow, settingsSecondaryButton } from "./SettingsSection";

const CHOICES = [
  {
    value: false,
    label: "Final results only",
    hint: "When an agent finishes, fails or needs you",
  },
  {
    value: true,
    label: "Every update",
    hint: "Also its progress messages while it works",
  },
] as const;

/**
 * "Agent updates": notify for an agent's progress messages ("⏳ Working —
 * 5 min") or only for finished work. Account-wide, so it applies to background
 * push and in-app notifications on every device.
 */
export function AgentUpdatesSetting({
  reportLoadError = true,
}: {
  /** Off where a sibling section already reports the shared load failure. */
  reportLoadError?: boolean;
}) {
  const id = useId();
  const preferences = useNotificationPreferencesStore((state) => state.preferences);
  const ensureLoaded = useNotificationPreferencesStore((state) => state.ensureLoaded);
  const update = useNotificationPreferencesStore((state) => state.update);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    void ensureLoaded().then((loaded) => {
      if (active && !loaded && reportLoadError) {
        setLoadFailed(true);
        setError("Couldn't load your notification choices.");
      }
    });
    return () => {
      active = false;
    };
  }, [ensureLoaded, reportLoadError, attempt]);

  const retry = () => {
    setError(null);
    setLoadFailed(false);
    setAttempt((value) => value + 1);
  };

  const choose = async (agentProgress: boolean) => {
    setError(null);
    try {
      await update({ agentProgress });
    } catch {
      setError("Couldn't save. Try again.");
    }
  };

  const repliesOff = preferences?.agentReplies === false;
  return (
    <div className={settingsRow}>
      <div className="min-w-0">
        <div id={`${id}-label`} className={settingsLabel}>
          Agent updates
        </div>
        <p id={`${id}-hint`} className={settingsHint}>
          {repliesOff ? "Agent replies are off" : "Applies to all your devices"}
        </p>
      </div>
      <div
        role="radiogroup"
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-hint`}
        className="flex min-w-0 flex-col gap-3"
      >
        {CHOICES.map((choice) => (
          <label
            key={String(choice.value)}
            htmlFor={`${id}-${choice.value}`}
            className="flex min-h-[44px] cursor-pointer items-start gap-3 sm:min-h-0"
          >
            <input
              id={`${id}-${choice.value}`}
              type="radio"
              name={`${id}-agent-updates`}
              className="mt-0.5 size-4 shrink-0 cursor-pointer accent-accent"
              checked={preferences ? preferences.agentProgress === choice.value : false}
              disabled={!preferences || repliesOff}
              onChange={() => void choose(choice.value)}
            />
            <span className="min-w-0">
              <span className="block text-[0.929rem] leading-5 text-text">{choice.label}</span>
              <span className={`block ${settingsHint}`}>{choice.hint}</span>
            </span>
          </label>
        ))}
        {error && (
          <p className="text-[0.929rem] leading-5 text-error-bright" role="alert">
            {error}
          </p>
        )}
        {loadFailed && (
          <button type="button" className={`${settingsSecondaryButton} self-start`} onClick={retry}>
            Try again
          </button>
        )}
      </div>
    </div>
  );
}
