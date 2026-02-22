import { useState } from "react";
import { useNotificationsStore } from "../stores/notifications";
import type { WorkspaceInvite } from "@thechat/shared";

function InviteNotificationCard({ invite }: { invite: WorkspaceInvite }) {
  const acceptInvite = useNotificationsStore((s) => s.acceptInvite);
  const declineInvite = useNotificationsStore((s) => s.declineInvite);
  const [loading, setLoading] = useState<"accept" | "decline" | null>(null);

  const handleAccept = async () => {
    setLoading("accept");
    try {
      await acceptInvite(invite.id);
    } catch {
      // error handling
    } finally {
      setLoading(null);
    }
  };

  const handleDecline = async () => {
    setLoading("decline");
    try {
      await declineInvite(invite.id);
    } catch {
      // error handling
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="invite-card">
      <div className="invite-card-info">
        <div className="invite-card-workspace">{invite.workspaceName}</div>
        <div className="invite-card-inviter">
          Invited by {invite.inviterName}
        </div>
      </div>
      <div className="invite-card-actions">
        <button
          className="invite-accept-btn"
          onClick={handleAccept}
          disabled={loading !== null}
        >
          {loading === "accept" ? "..." : "Accept"}
        </button>
        <button
          className="invite-decline-btn"
          onClick={handleDecline}
          disabled={loading !== null}
        >
          {loading === "decline" ? "..." : "Decline"}
        </button>
      </div>
    </div>
  );
}

export function NotificationsRoute() {
  const notifications = useNotificationsStore((s) => s.notifications);
  const loading = useNotificationsStore((s) => s.loading);

  return (
    <div className="notifications-view">
      <h2 className="notifications-title">Notifications</h2>
      {loading && notifications.length === 0 ? (
        <div className="notifications-empty">Loading...</div>
      ) : notifications.length === 0 ? (
        <div className="notifications-empty">No notifications</div>
      ) : (
        <div className="notifications-list">
          {notifications.map((n) => {
            switch (n.type) {
              case "workspace_invite":
                return (
                  <InviteNotificationCard
                    key={n.invite.id}
                    invite={n.invite}
                  />
                );
            }
          })}
        </div>
      )}
    </div>
  );
}
