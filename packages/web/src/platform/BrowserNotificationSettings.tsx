import { useState } from "react";
import { isWeb } from "@thechat/client/platform/environment";

/** Page-lifetime notifications only; this does not register a push worker. */
export function BrowserNotificationSettings() {
  const [permission, setPermission] = useState<NotificationPermission | "unavailable">(
    typeof Notification === "undefined" ? "unavailable" : Notification.permission,
  );
  if (!isWeb) return null;
  return <section className="rounded-xl border border-border-subtle bg-surface p-5" aria-label="Browser notifications">
    <h2 className="font-semibold">Browser notifications</h2>
    {permission === "granted" ? <p>Notifications enabled while TheChat is open.</p>
      : permission === "denied" ? <p>Notifications are blocked. Change this site's permission in your browser settings.</p>
      : permission === "unavailable" ? <p>This browser does not support page notifications.</p>
      : <button type="button" className="mt-2 rounded border border-border-subtle px-3 py-2" onClick={() => {
          void Notification.requestPermission().then(setPermission).catch(() => setPermission("unavailable"));
        }}>Enable browser notifications</button>}
  </section>;
}
