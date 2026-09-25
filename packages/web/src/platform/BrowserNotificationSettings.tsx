import { useState } from "react";
import { isWeb } from "@thechat/client/platform/environment";
import {
  SettingsSection,
  settingsCard,
  settingsLabel,
  settingsRow,
  settingsSecondaryButton,
  settingsValue,
} from "@thechat/client/components/SettingsSection";

/** Page-lifetime notifications only; this does not register a push worker. */
export function BrowserNotificationSettings() {
  const [permission, setPermission] = useState<NotificationPermission | "unavailable">(
    typeof Notification === "undefined" ? "unavailable" : Notification.permission,
  );
  if (!isWeb) return null;
  return (
    <SettingsSection id="browser-notifications-heading" title="Browser notifications">
      <div className={settingsCard}>
        <div className={settingsRow}>
          {/* Centre the label on the request button when it is shown. */}
          <div className={`${settingsLabel} ${permission === "default" ? "sm:pt-1.5" : ""}`}>Permission</div>
          <div className="min-w-0">
            {permission === "granted" ? (
              <p className={settingsValue}>Notifications enabled while TheChat is open.</p>
            ) : permission === "denied" ? (
              <p className={settingsValue}>
                Notifications are blocked. Change this site's permission in your browser settings.
              </p>
            ) : permission === "unavailable" ? (
              <p className={settingsValue}>This browser does not support page notifications.</p>
            ) : (
              <button
                type="button"
                className={settingsSecondaryButton}
                onClick={() => {
                  void Notification.requestPermission().then(setPermission).catch(() => setPermission("unavailable"));
                }}
              >
                Enable browser notifications
              </button>
            )}
          </div>
        </div>
      </div>
    </SettingsSection>
  );
}
