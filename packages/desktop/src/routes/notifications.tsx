import { useMemo, useState } from "react";
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
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-raised px-4 py-3">
      <div>
        <div className="mt-0.5 text-[12px] text-text-muted">
          Invited by {invite.inviterName}
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        <button
          className="cursor-pointer rounded-lg border-none bg-accent/15 px-3.5 py-1.5 text-[12px] font-medium text-accent transition-colors duration-150 hover:not-disabled:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={handleAccept}
          disabled={loading !== null}
        >
          {loading === "accept" ? "..." : "Accept"}
        </button>
        <button
          className="cursor-pointer rounded-lg border-none bg-button px-3.5 py-1.5 text-[12px] font-medium text-text-secondary transition-colors duration-150 hover:not-disabled:bg-button-hover disabled:cursor-not-allowed disabled:opacity-50"
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

  const groupedInvites = useMemo(() => {
    const groups = new Map<string, WorkspaceInvite[]>();

    notifications.forEach((n) => {
      if (n.type !== "workspace_invite") return;
      const existing = groups.get(n.invite.workspaceName) ?? [];
      existing.push(n.invite);
      groups.set(n.invite.workspaceName, existing);
    });

    return Array.from(groups.entries())
      .map(([workspaceName, invites]) => ({ workspaceName, invites }))
      .sort((a, b) => a.workspaceName.localeCompare(b.workspaceName));
  }, [notifications]);

  return (
    <div className="mx-auto h-full max-w-[700px] overflow-y-auto p-6">
      <h2 className="mb-4 text-[17px] font-semibold tracking-tight text-text">Notifications</h2>
      {loading && notifications.length === 0 ? (
        <div className="text-[13px] text-text-muted">Loading...</div>
      ) : notifications.length === 0 ? (
        <div className="text-[13px] text-text-muted">No notifications</div>
      ) : (
        <div className="flex flex-col gap-4">
          {groupedInvites.map((group) => (
            <section key={group.workspaceName} className="rounded-xl border border-border bg-surface p-3">
              <h3 className="mb-2 px-1 text-[13px] font-semibold text-text">{group.workspaceName}</h3>
              <div className="flex flex-col gap-2">
                {group.invites.map((invite) => (
                  <InviteNotificationCard key={invite.id} invite={invite} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
