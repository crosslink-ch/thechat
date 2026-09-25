import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { ActivityItem } from "@thechat/shared";
import { useActivityStore } from "../stores/activity";
import { useNotificationsStore } from "../stores/notifications";
import { useWorkspacesStore } from "../stores/workspaces";
import { Check, CheckCheck } from "lucide-react";
import { buttonClass, iconButtonClass } from "../components/ui";

const panelClass = "rounded-xl border border-border bg-white/[0.03]";

function relativeTime(iso: string) {
  const elapsedMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.max(0, Math.floor(elapsedMs / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function messagePreview(item: ActivityItem) {
  const content = item.latestMessage.content.trim();
  return content || "Sent an attachment";
}

export function ActivityRoute() {
  const navigate = useNavigate();
  const items = useActivityStore((state) => state.items);
  const totalUnreadMessages = useActivityStore(
    (state) => state.totalUnreadMessages,
  );
  const activityLoading = useActivityStore((state) => state.loading);
  const activityError = useActivityStore((state) => state.error);
  const fetchActivity = useActivityStore((state) => state.fetchActivity);
  const markConversationRead = useActivityStore(
    (state) => state.markConversationRead,
  );
  const markAllRead = useActivityStore((state) => state.markAllRead);

  const notifications = useNotificationsStore((state) => state.notifications);
  const notificationsLoading = useNotificationsStore((state) => state.loading);
  const notificationsError = useNotificationsStore((state) => state.error);
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

  const activeWorkspaceId = useWorkspacesStore(
    (state) => state.activeWorkspace?.id ?? null,
  );
  const selectWorkspace = useWorkspacesStore((state) => state.selectWorkspace);
  const [processingIds, setProcessingIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    void fetchActivity();
    void fetchNotifications();
  }, [fetchActivity, fetchNotifications]);

  const runAction = async (id: string, action: () => Promise<void>) => {
    setProcessingIds((current) => new Set(current).add(id));
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Could not update activity",
      );
    } finally {
      setProcessingIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  };

  const openActivity = async (item: ActivityItem) => {
    setActionError(null);
    try {
      if (activeWorkspaceId !== item.workspaceId) {
        const selected = await selectWorkspace(item.workspaceId);
        if (!selected) {
          throw new Error(`Couldn't open ${item.workspaceName}`);
        }
      }
      navigate(
        item.conversationType === "group"
          ? {
              to: "/channel/$id",
              params: { id: item.conversationId },
            }
          : {
              to: "/dm/$id",
              params: { id: item.conversationId },
              search: {
                threadId: item.latestMessage.threadId ?? undefined,
              },
            },
      );
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Could not open this activity",
      );
    }
  };

  const noActivity =
    !activityLoading &&
    !notificationsLoading &&
    items.length === 0 &&
    notifications.length === 0;

  return (
    <div className="flex h-full flex-col bg-base">
      <div className="shrink-0 px-4 pb-4 pt-6 sm:px-8 sm:pt-8">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-[1.429rem] font-semibold tracking-tight text-text">Activity</h1>
          <p className="mt-1 text-[0.929rem] text-text-muted">
            Unread messages and requests from every workspace.
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-10 pt-2 sm:px-8">
        {(activityError || notificationsError || actionError) && (
          <div
            role="alert"
            className="mx-auto mb-4 max-w-3xl rounded-lg border border-error-msg-border bg-error-msg-bg px-3 py-2 text-[0.929rem] text-error-bright"
          >
            {actionError ?? activityError ?? notificationsError}
          </div>
        )}

        {noActivity ? (
          <div className="mx-auto max-w-3xl py-16 text-center">
            <div className="text-[1rem] font-medium text-text-secondary">
              You&apos;re all caught up
            </div>
            <div className="mt-1 text-[0.929rem] text-text-dimmed">
              New messages and requests will appear here.
            </div>
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-8">
            {(items.length > 0 || activityLoading) && (
              <section aria-labelledby="activity-unread-heading">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <h2
                      id="activity-unread-heading"
                      className="text-[1rem] font-semibold text-text"
                    >
                      Unread messages
                    </h2>
                    {totalUnreadMessages > 0 && (
                      <p className="mt-0.5 text-[0.857rem] text-text-dimmed">
                        {totalUnreadMessages} unread across your workspaces
                      </p>
                    )}
                  </div>
                  {items.length > 0 && (
                    <button
                      type="button"
                      disabled={processingIds.size > 0}
                      className={buttonClass("secondary", "sm")}
                      onClick={() =>
                        void runAction("all", () => markAllRead())
                      }
                    >
                      <CheckCheck size={14} aria-hidden="true" />
                      {processingIds.has("all") ? "Working..." : "Mark all as read"}
                    </button>
                  )}
                </div>

                {activityLoading && items.length === 0 ? (
                  <div className={`px-4 py-8 text-center text-[0.929rem] text-text-dimmed ${panelClass}`}>
                    Loading activity...
                  </div>
                ) : (
                  <div className={`flex flex-col gap-0.5 p-1 ${panelClass}`}>
                    {items.map((item) => {
                      const label =
                        item.conversationType === "group"
                          ? `# ${item.conversationName}`
                          : item.conversationName;
                      const processing =
                        processingIds.has(item.conversationId) ||
                        processingIds.has("all");
                      return (
                        <article
                          key={item.conversationId}
                          data-testid={`activity-item-${item.conversationId}`}
                          className="flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors duration-150 hover:bg-white/[0.04]"
                        >
                          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-white/[0.06] text-[0.857rem] font-semibold text-text-secondary">
                            {item.workspaceName.charAt(0).toUpperCase()}
                          </span>
                          <button
                            type="button"
                            className="min-w-0 flex-1 cursor-pointer border-none bg-transparent text-left"
                            aria-label={`Open ${label} in ${item.workspaceName}`}
                            onClick={() => void openActivity(item)}
                          >
                            <span className="flex items-center gap-2">
                              <span className="truncate text-[0.929rem] font-semibold text-text">
                                {label}
                              </span>
                              <span className="truncate text-[0.786rem] text-text-dimmed">
                                {item.workspaceName}
                              </span>
                              <span className="ml-auto shrink-0 text-[0.786rem] text-text-dimmed">
                                {relativeTime(item.latestMessage.createdAt)}
                              </span>
                            </span>
                            <span className="mt-0.5 block truncate text-[0.929rem] text-text-muted">
                              <strong className="font-medium text-text-secondary">
                                {item.latestMessage.senderName}
                              </strong>{" "}
                              {messagePreview(item)}
                            </span>
                            <span className="mt-1.5 inline-flex rounded-full bg-accent/15 px-2 py-0.5 text-[0.786rem] font-medium text-accent">
                              {item.unreadCount} unread
                            </span>
                          </button>
                          <button
                            type="button"
                            disabled={processing}
                            aria-label={`Mark ${item.conversationName} as read`}
                            title="Mark as read"
                            className={iconButtonClass("md")}
                            onClick={() =>
                              void runAction(item.conversationId, () =>
                                markConversationRead(item.conversationId),
                              )
                            }
                          >
                            <Check size={16} aria-hidden="true" />
                          </button>
                        </article>
                      );
                    })}
                  </div>
                )}
              </section>
            )}

            {(notifications.length > 0 || notificationsLoading) && (
              <section aria-labelledby="activity-requests-heading">
                <h2
                  id="activity-requests-heading"
                  className="mb-3 text-[1rem] font-semibold text-text"
                >
                  Requests
                </h2>
                {notificationsLoading && notifications.length === 0 ? (
                  <div className={`px-4 py-8 text-center text-[0.929rem] text-text-dimmed ${panelClass}`}>
                    Loading requests...
                  </div>
                ) : (
                  <div className="flex flex-col gap-3">
                    {notifications.map((notification) => {
                      if (notification.type === "workspace_invite") {
                        const invite = notification.invite;
                        const processing = processingIds.has(invite.id);
                        return (
                          <article
                            key={`workspace:${invite.id}`}
                            data-testid="workspace-invite-notification"
                            className={`p-4 ${panelClass}`}
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
                                  void runAction(invite.id, () =>
                                    acceptInvite(invite.id),
                                  )
                                }
                              >
                                {processing ? "Working..." : "Accept"}
                              </button>
                              <button
                                type="button"
                                disabled={processing}
                                className={buttonClass("secondary", "sm")}
                                onClick={() =>
                                  void runAction(invite.id, () =>
                                    declineInvite(invite.id),
                                  )
                                }
                              >
                                Decline
                              </button>
                            </div>
                          </article>
                        );
                      }

                      const invite = notification.invite;
                      const processing = processingIds.has(invite.id);
                      return (
                        <article
                          key={`bot:${invite.id}`}
                          data-testid="bot-workspace-invite-notification"
                          className={`p-4 ${panelClass}`}
                        >
                          <div className="text-[1rem] font-medium text-text">
                            Add {invite.botName} to {invite.workspaceName}
                          </div>
                          <div className="mt-1 text-[0.929rem] leading-relaxed text-text-muted">
                            {invite.requesterName} wants to add a bot you own to this
                            workspace. Approve only if you trust the workspace members.
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
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
