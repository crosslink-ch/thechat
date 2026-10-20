import { useEffect, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { BotRequestPublic } from "@thechat/shared";
import { BotRequestCard } from "../components/BotRequestCard";
import { Avatar } from "../components/Avatar";
import {
  blockedRequestIds,
  compareRequests,
  useBotRequestsStore,
  useOpenBotRequests,
} from "../stores/bot-requests";
import { useWorkspacesStore } from "../stores/workspaces";

const panelClass = "rounded-xl border border-border bg-white/[0.03]";

interface RequestGroup {
  key: string;
  botName: string;
  botUserId: string;
  botAvatar: BotRequestPublic["botAvatar"];
  where: string;
  requests: BotRequestPublic[];
}

/** Open requests grouped by bot and conversation, oldest first. */
function groupRequests(requests: BotRequestPublic[]): RequestGroup[] {
  const groups = new Map<string, RequestGroup>();
  for (const request of [...requests].sort(compareRequests)) {
    const key = `${request.botId}\0${request.conversationId}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        botName: request.botName,
        botUserId: request.botUserId,
        botAvatar: request.botAvatar,
        where:
          request.conversationType === "group"
            ? `#${request.conversationName ?? "channel"}`
            : "Direct message",
        requests: [],
      };
      groups.set(key, group);
    }
    group.requests.push(request);
  }
  return [...groups.values()];
}

export function InboxRoute() {
  const navigate = useNavigate();
  const fetchInbox = useBotRequestsStore((state) => state.fetchInbox);
  const loading = useBotRequestsStore((state) => state.inboxLoading);
  const loaded = useBotRequestsStore((state) => state.inboxLoaded);
  const error = useBotRequestsStore((state) => state.inboxError);
  const recentIds = useBotRequestsStore((state) => state.recentIds);
  const byId = useBotRequestsStore((state) => state.byId);
  const open = useOpenBotRequests();
  const activeWorkspaceId = useWorkspacesStore(
    (state) => state.activeWorkspace?.id ?? null,
  );
  const selectWorkspace = useWorkspacesStore((state) => state.selectWorkspace);

  useEffect(() => {
    void fetchInbox();
  }, [fetchInbox]);

  const groups = useMemo(() => groupRequests(open), [open]);
  const blocked = useMemo(() => blockedRequestIds(Object.values(byId)), [byId]);
  const recent = useMemo(() => {
    const ids = new Set(recentIds);
    // Requests resolved here since the last fetch belong in "recent" too.
    for (const request of Object.values(byId)) {
      if (request.status !== "open") ids.add(request.id);
    }
    return [...ids]
      .map((id) => byId[id])
      .filter((request): request is BotRequestPublic => Boolean(request))
      .filter((request) => request.status !== "open")
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, 30);
  }, [byId, recentIds]);

  const openContext = (request: BotRequestPublic) => {
    if (request.workspaceId && request.workspaceId !== activeWorkspaceId) {
      selectWorkspace(request.workspaceId);
    }
    if (request.conversationType === "group") {
      navigate({ to: "/channel/$id", params: { id: request.conversationId } });
      return;
    }
    navigate({
      to: "/dm/$id",
      params: { id: request.conversationId },
      search: { threadId: request.threadId ?? undefined },
    });
  };

  return (
    <div className="flex h-full flex-col bg-base">
      <div className="shrink-0 px-4 pb-4 pt-6 sm:px-8 sm:pt-8">
        <div className="mx-auto max-w-2xl">
          <h1 className="text-[1.429rem] font-semibold tracking-tight text-text">Inbox</h1>
          <p className="mt-1 text-[0.929rem] text-text-muted">
            Approvals, questions and reviews that bots are waiting on.
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-10 pt-2 sm:px-8">
        <div className="mx-auto flex max-w-2xl flex-col gap-6">
          {error && (
            <div
              role="alert"
              className="rounded-lg border border-error-msg-border bg-error-msg-bg px-3 py-2 text-[0.929rem] text-error-bright"
            >
              {error}
            </div>
          )}

          <section aria-labelledby="inbox-open-heading">
            <h2
              id="inbox-open-heading"
              className="mb-2 text-[0.857rem] font-semibold uppercase tracking-wide text-text-dimmed"
            >
              Waiting on you{open.length > 0 ? ` (${open.length})` : ""}
            </h2>
            {loading && !loaded && open.length === 0 ? (
              <div className="py-10 text-center text-[0.929rem] text-text-dimmed">
                Loading requests...
              </div>
            ) : groups.length === 0 ? (
              <div
                data-testid="inbox-empty"
                className={`${panelClass} px-4 py-8 text-center text-[0.929rem] text-text-dimmed`}
              >
                Nothing is waiting on you.
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {groups.map((group) => (
                  <div key={group.key} data-testid="inbox-group" className="flex flex-col gap-2">
                    <div className="flex items-center gap-2 text-[0.857rem] text-text-muted">
                      <Avatar
                        aria-hidden="true"
                        name={group.botName}
                        colorKey={group.botUserId}
                        bot
                        botAvatar={group.botAvatar}
                        size={20}
                        className="size-5 text-[0.714rem]"
                      />
                      <span className="font-medium text-text-secondary">{group.botName}</span>
                      <span aria-hidden="true">·</span>
                      <span>{group.where}</span>
                    </div>
                    {group.requests.map((request) => (
                      <BotRequestCard
                        key={request.id}
                        request={request}
                        blocked={blocked.has(request.id)}
                        showContext
                        onOpenContext={() => openContext(request)}
                      />
                    ))}
                  </div>
                ))}
              </div>
            )}
          </section>

          {recent.length > 0 && (
            <section aria-labelledby="inbox-recent-heading">
              <h2
                id="inbox-recent-heading"
                className="mb-2 text-[0.857rem] font-semibold uppercase tracking-wide text-text-dimmed"
              >
                Recently resolved
              </h2>
              <div className={`${panelClass} flex flex-col gap-1 px-3 py-2`}>
                {recent.map((request) => (
                  <BotRequestCard
                    key={request.id}
                    request={request}
                    showContext
                    onOpenContext={() => openContext(request)}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
