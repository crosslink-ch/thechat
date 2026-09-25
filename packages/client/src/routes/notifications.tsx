import { useEffect, useState } from "react";
import { useNotificationsStore } from "../stores/notifications";
import { buttonClass } from "../components/ui";

const requestCardClass = "rounded-xl border border-border bg-white/[0.03] p-4";

export function NotificationsRoute() {
  const notifications = useNotificationsStore((state) => state.notifications);
  const loading = useNotificationsStore((state) => state.loading);
  const error = useNotificationsStore((state) => state.error);
  const fetchNotifications = useNotificationsStore(
    (state) => state.fetchNotifications,
  );
  const acceptInvite = useNotificationsStore((state) => state.acceptInvite);
  const declineInvite = useNotificationsStore((state) => state.declineInvite);
  const acceptBotWorkspaceInvite = useNotificationsStore(
    (state) => state.acceptBotWorkspaceInvite,
  );
  const declineBotWorkspaceInvite = useNotificationsStore(
    (state) => state.declineBotWorkspaceInvite,
  );
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    void fetchNotifications();
  }, [fetchNotifications]);

  const runAction = async (inviteId: string, action: () => Promise<void>) => {
    setProcessingId(inviteId);
    setActionError(null);
    try {
      await action();
    } catch (actionFailure) {
      setActionError(
        actionFailure instanceof Error
          ? actionFailure.message
          : "Could not update the invitation",
      );
    } finally {
      setProcessingId(null);
    }
  };

  return (
    <div className="flex h-full flex-col bg-base">
      <div className="shrink-0 px-4 pb-4 pt-6 sm:px-8 sm:pt-8">
        <div className="mx-auto max-w-2xl">
          <h1 className="text-[1.429rem] font-semibold tracking-tight text-text">Notifications</h1>
          <p className="mt-1 text-[0.929rem] text-text-muted">
            Workspace invitations and requests to use bots you own.
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-10 pt-2 sm:px-8">
        {(error || actionError) && (
          <div
            role="alert"
            className="mx-auto mb-3 max-w-2xl rounded-lg border border-error-msg-border bg-error-msg-bg px-3 py-2 text-[0.929rem] text-error-bright"
          >
            {actionError ?? error}
          </div>
        )}

        {loading && notifications.length === 0 ? (
          <div className="py-16 text-center text-[0.929rem] text-text-dimmed">
            Loading notifications...
          </div>
        ) : notifications.length === 0 ? (
          <div className="py-16 text-center text-[0.929rem] text-text-dimmed">
            No notifications
          </div>
        ) : (
          <div className="mx-auto flex max-w-2xl flex-col gap-3">
            {notifications.map((notification) => {
              if (notification.type === "workspace_invite") {
                const invite = notification.invite;
                const processing = processingId === invite.id;
                return (
                  <article
                    key={`workspace:${invite.id}`}
                    data-testid="workspace-invite-notification"
                    className={requestCardClass}
                  >
                    <div className="text-[1rem] font-medium text-text">
                      Join {invite.workspaceName}
                    </div>
                    <div className="mt-1 text-[0.929rem] text-text-muted">
                      {invite.inviterName} invited you to this workspace.
                    </div>
                    <div className="mt-3.5 flex gap-2">
                      <button
                        type="button"
                        disabled={processing}
                        className={buttonClass("primary", "sm")}
                        onClick={() =>
                          void runAction(invite.id, () => acceptInvite(invite.id))
                        }
                      >
                        {processing ? "Working..." : "Accept"}
                      </button>
                      <button
                        type="button"
                        disabled={processing}
                        className={buttonClass("secondary", "sm")}
                        onClick={() =>
                          void runAction(invite.id, () => declineInvite(invite.id))
                        }
                      >
                        Decline
                      </button>
                    </div>
                  </article>
                );
              }

              const invite = notification.invite;
              const processing = processingId === invite.id;
              return (
                <article
                  key={`bot:${invite.id}`}
                  data-testid="bot-workspace-invite-notification"
                  className={requestCardClass}
                >
                  <div className="text-[1rem] font-medium text-text">
                    Add {invite.botName} to {invite.workspaceName}
                  </div>
                  <div className="mt-1 text-[0.929rem] leading-relaxed text-text-muted">
                    {invite.requesterName} wants to add a bot you own to this
                    workspace. Approve only if you trust the workspace members.
                  </div>
                  <div className="mt-2 break-all font-mono text-[0.786rem] text-text-dimmed">
                    Bot ID: {invite.botId}
                  </div>
                  <div className="mt-3.5 flex gap-2">
                    <button
                      type="button"
                      disabled={processing}
                      className={buttonClass("primary", "sm")}
                      onClick={() =>
                        void runAction(invite.id, () =>
                          acceptBotWorkspaceInvite(invite.id),
                        )
                      }
                    >
                      {processing ? "Working..." : "Approve"}
                    </button>
                    <button
                      type="button"
                      disabled={processing}
                      className={buttonClass("secondary", "sm")}
                      onClick={() =>
                        void runAction(invite.id, () =>
                          declineBotWorkspaceInvite(invite.id),
                        )
                      }
                    >
                      Decline
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
