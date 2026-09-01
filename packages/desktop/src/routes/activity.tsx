import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { ActivityItem } from "@thechat/shared";
import { useActivityStore } from "../stores/activity";
import { useNotificationsStore } from "../stores/notifications";
import { useWorkspacesStore } from "../stores/workspaces";

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
      <div className="border-b border-border px-5 py-4">
        <h1 className="text-[1.071rem] font-semibold text-text">Activity</h1>
        <p className="mt-1 text-[0.786rem] text-text-muted">
          Unread messages and requests from every workspace.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {(activityError || notificationsError || actionError) && (
          <div
            role="alert"
            className="mx-auto mb-4 max-w-3xl rounded-lg border border-error-border bg-error-msg-bg px-3 py-2 text-[0.857rem] text-error-bright"
          >
            {actionError ?? activityError ?? notificationsError}
          </div>
        )}

        {noActivity ? (
          <div className="mx-auto max-w-3xl py-16 text-center">
            <div className="text-[0.929rem] font-medium text-text-secondary">
              You&apos;re all caught up
            </div>
            <div className="mt-1 text-[0.786rem] text-text-dimmed">
              New messages and requests will appear here.
            </div>
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-7">
            {(items.length > 0 || activityLoading) && (
              <section aria-labelledby="activity-unread-heading">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <h2
                      id="activity-unread-heading"
                      className="text-[0.929rem] font-semibold text-text"
                    >
                      Unread messages
                    </h2>
                    {totalUnreadMessages > 0 && (
                      <p className="mt-0.5 text-[0.714rem] text-text-dimmed">
                        {totalUnreadMessages} unread across your workspaces
                      </p>
                    )}
                  </div>
                  {items.length > 0 && (
                    <button
                      type="button"
                      disabled={processingIds.size > 0}
                      className="cursor-pointer rounded-md border border-border bg-transparent px-2.5 py-1.5 text-[0.786rem] text-text-secondary transition-colors hover:bg-hover hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
                      onClick={() =>
                        void runAction("all", () => markAllRead())
                      }
                    >
                      {processingIds.has("all") ? "Working..." : "Mark all as read"}
                    </button>
                  )}
                </div>

                {activityLoading && items.length === 0 ? (
                  <div className="rounded-lg border border-border bg-raised px-4 py-8 text-center text-[0.857rem] text-text-muted">
                    Loading activity...
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
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
                          className="flex items-start gap-3 rounded-lg border border-border bg-raised p-3 transition-colors hover:border-border-strong"
                        >
                          <span className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-[0.786rem] font-semibold text-accent">
                            {item.workspaceName.charAt(0).toUpperCase()}
                          </span>
                          <button
                            type="button"
                            className="min-w-0 flex-1 cursor-pointer border-none bg-transparent text-left"
                            aria-label={`Open ${label} in ${item.workspaceName}`}
                            onClick={() => void openActivity(item)}
                          >
                            <span className="flex items-center gap-2">
                              <span className="truncate text-[0.857rem] font-semibold text-text">
                                {label}
                              </span>
                              <span className="truncate text-[0.714rem] text-text-dimmed">
                                {item.workspaceName}
                              </span>
                              <span className="ml-auto shrink-0 text-[0.714rem] text-text-dimmed">
                                {relativeTime(item.latestMessage.createdAt)}
                              </span>
                            </span>
                            <span className="mt-1 block truncate text-[0.786rem] text-text-secondary">
                              <strong className="font-medium text-text-muted">
                                {item.latestMessage.senderName}
                              </strong>{" "}
                              {messagePreview(item)}
                            </span>
                            <span className="mt-1.5 inline-flex rounded-full bg-accent/15 px-2 py-0.5 text-[0.714rem] font-medium text-accent">
                              {item.unreadCount} unread
                            </span>
                          </button>
                          <button
                            type="button"
                            disabled={processing}
                            aria-label={`Mark ${item.conversationName} as read`}
                            title="Mark as read"
                            className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md border-none bg-transparent text-text-dimmed transition-colors hover:bg-hover hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
                            onClick={() =>
                              void runAction(item.conversationId, () =>
                                markConversationRead(item.conversationId),
                              )
                            }
                          >
                            ✓
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
                  className="mb-3 text-[0.929rem] font-semibold text-text"
                >
                  Requests
                </h2>
                {notificationsLoading && notifications.length === 0 ? (
                  <div className="rounded-lg border border-border bg-raised px-4 py-8 text-center text-[0.857rem] text-text-muted">
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
                            className="rounded-lg border border-border bg-raised p-4"
                          >
                            <div className="text-[0.929rem] font-medium text-text">
                              Join {invite.workspaceName}
                            </div>
                            <div className="mt-1 text-[0.786rem] text-text-muted">
                              {invite.inviterName} invited you to this workspace.
                            </div>
                            <div className="mt-4 flex gap-2">
                              <button
                                type="button"
                                disabled={processing}
                                className="cursor-pointer rounded-md bg-accent px-3 py-1.5 text-[0.786rem] font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
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
                                className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-[0.786rem] text-text-secondary hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
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
                          className="rounded-lg border border-border bg-raised p-4"
                        >
                          <div className="text-[0.929rem] font-medium text-text">
                            Add {invite.botName} to {invite.workspaceName}
                          </div>
                          <div className="mt-1 text-[0.786rem] leading-relaxed text-text-muted">
                            {invite.requesterName} wants to add a bot you own to this
                            workspace. Approve only if you trust the workspace members.
                          </div>
                          <div className="mt-4 flex gap-2">
                            <button
                              type="button"
                              disabled={processing}
                              className="cursor-pointer rounded-md bg-accent px-3 py-1.5 text-[0.786rem] font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
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
                              className="cursor-pointer rounded-md border border-border px-3 py-1.5 text-[0.786rem] text-text-secondary hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
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
