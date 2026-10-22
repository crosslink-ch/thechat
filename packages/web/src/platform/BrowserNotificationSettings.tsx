import { useEffect, useId, useState } from "react";
import type { NotificationPreferences } from "@thechat/shared";
import { isWeb } from "@thechat/client/platform/environment";
import { api } from "@thechat/client/lib/api";
import { authHeaders } from "@thechat/client/lib/eden";
import {
  SettingsSection,
  settingsCard,
  settingsHint,
  settingsLabel,
  settingsPrimaryButton,
  settingsQuietButton,
  settingsRow,
  settingsSecondaryButton,
  settingsValue,
} from "@thechat/client/components/SettingsSection";
import {
  disablePush,
  enablePush,
  isIosDevice,
  sendTestPush,
  usePushStatus,
  type PushStatus,
} from "./push";

const PREFERENCE_ROWS: { key: keyof NotificationPreferences; label: string; hint: string }[] = [
  { key: "directMessages", label: "Direct messages", hint: "Messages sent to you" },
  { key: "mentions", label: "Mentions", hint: "When someone @mentions you in a channel" },
  { key: "agentReplies", label: "Agent replies", hint: "When an agent answers you" },
  {
    key: "agentRequests",
    label: "Agent requests",
    hint: "Approvals and questions an agent is waiting on",
  },
];

function statusText(status: PushStatus) {
  switch (status.state) {
    case "checking":
      return "Checking…";
    case "on":
      return "On. You'll get notifications when TheChat is closed.";
    case "off":
      return "Off.";
    case "working":
      return "Updating…";
    case "blocked":
      return isIosDevice()
        ? "Blocked. Allow notifications for TheChat in iOS Settings → Notifications."
        : "Blocked. Allow notifications for this site in your browser's site settings, then reload.";
    case "install-required":
      return "On iPhone and iPad, add TheChat to your Home Screen first: tap Share, then Add to Home Screen. Open it from there and turn notifications on.";
    case "unavailable":
      return "Background notifications aren't set up on this server yet.";
    case "unsupported":
      return "This browser doesn't support background notifications.";
    case "error":
      return status.message;
  }
}

function DeviceRow() {
  const status = usePushStatus();
  const [test, setTest] = useState<string | null>(null);
  const busy = status.state === "working" || status.state === "checking";

  const runTest = async () => {
    setTest("Sending…");
    const result = await sendTestPush();
    setTest(
      result === "sent"
        ? "Sent. It should appear in a few seconds."
        : result === "rate-limited"
          ? "Wait a few seconds and try again."
          : result === "invalid"
            ? "This device isn't registered anymore. Turn notifications on again."
            : "Couldn't send a test notification. Try again.",
    );
  };

  return (
    <div className={settingsRow}>
      <div className="min-w-0 sm:pt-1.5">
        <div className={settingsLabel}>This device</div>
        <p className={settingsHint}>Notifications when TheChat is closed</p>
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <p className={settingsValue} role="status">
          {statusText(status)}
        </p>
        <div className="flex flex-wrap gap-2 empty:hidden">
          {(status.state === "off" || status.state === "error") && (
            <button
              type="button"
              className={settingsPrimaryButton}
              onClick={() => void enablePush()}
            >
              Turn on notifications
            </button>
          )}
          {status.state === "on" && (
            <>
              <button
                type="button"
                className={settingsSecondaryButton}
                onClick={() => void runTest()}
              >
                Send test notification
              </button>
              <button
                type="button"
                className={settingsQuietButton}
                disabled={busy}
                onClick={() => {
                  setTest(null);
                  void disablePush();
                }}
              >
                Turn off
              </button>
            </>
          )}
        </div>
        {test && status.state === "on" && (
          <p className={settingsHint} role="status">
            {test}
          </p>
        )}
      </div>
    </div>
  );
}

function PreferenceRows() {
  const status = usePushStatus();
  const id = useId();
  const [preferences, setPreferences] = useState<NotificationPreferences | null>(null);
  const [error, setError] = useState<string | null>(null);
  const relevant =
    status.state !== "unsupported" &&
    status.state !== "unavailable" &&
    status.state !== "checking";

  useEffect(() => {
    if (!relevant || preferences) return;
    let active = true;
    void api.push.preferences
      .get(authHeaders(null))
      .then(({ data, error: loadError }) => {
        if (!active) return;
        if (loadError || !data || "error" in data) setError("Couldn't load your notification choices.");
        else setPreferences(data as NotificationPreferences);
      })
      .catch(() => {
        if (active) setError("Couldn't load your notification choices.");
      });
    return () => {
      active = false;
    };
  }, [relevant, preferences]);

  if (!relevant) return null;

  const update = async (key: keyof NotificationPreferences, value: boolean) => {
    if (!preferences) return;
    const previous = preferences;
    setPreferences({ ...preferences, [key]: value });
    setError(null);
    try {
      const { data, error: saveError } = await api.push.preferences.patch(
        { [key]: value },
        authHeaders(null),
      );
      if (saveError || !data || "error" in data) throw new Error("save failed");
      setPreferences(data as NotificationPreferences);
    } catch {
      setPreferences(previous);
      setError("Couldn't save. Try again.");
    }
  };

  const checkbox = (key: keyof NotificationPreferences, label: string, hint: string) => (
    <label
      key={key}
      htmlFor={`${id}-${key}`}
      className="flex min-h-[44px] cursor-pointer items-start gap-3 sm:min-h-0"
    >
      <input
        id={`${id}-${key}`}
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 cursor-pointer accent-accent"
        checked={preferences?.[key] ?? false}
        disabled={!preferences}
        onChange={(event) => void update(key, event.target.checked)}
      />
      <span className="min-w-0">
        <span className="block text-[0.929rem] leading-5 text-text">{label}</span>
        <span className={`block ${settingsHint}`}>{hint}</span>
      </span>
    </label>
  );

  return (
    <>
      <div className={settingsRow}>
        <div className="min-w-0">
          <div className={settingsLabel}>Notify me about</div>
          <p className={settingsHint}>Applies to all your devices</p>
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          {PREFERENCE_ROWS.map((row) => checkbox(row.key, row.label, row.hint))}
        </div>
      </div>
      <div className={settingsRow}>
        <div className="min-w-0">
          <div className={settingsLabel}>Privacy</div>
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          {checkbox("showPreviews", "Show message previews", "Include message text on the lock screen")}
          {error && (
            <p className="text-[0.929rem] leading-5 text-error-bright" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    </>
  );
}

/** Background notifications for this browser plus account-wide choices. */
export function BrowserNotificationSettings() {
  if (!isWeb) return null;
  return (
    <SettingsSection id="browser-notifications-heading" title="Notifications">
      <div className={settingsCard}>
        <DeviceRow />
        <PreferenceRows />
      </div>
    </SettingsSection>
  );
}
