import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Bot,
  BotWorkspaceInvite,
  BotWorkspaceInviteResult,
  WorkspaceMember,
  WorkspaceMemberRole,
  WorkspaceWithDetails,
} from "@thechat/shared";
import { api } from "../lib/api";
import { wsEvents } from "../lib/ws-events";
import { useAuthStore } from "../stores/auth";
import { useWorkspacesStore } from "../stores/workspaces";
import { UserAvatar } from "../components/UserAvatar";

function authHeaders(token: string) {
  return { authorization: `Bearer ${token}` };
}

function apiError(error: unknown, fallback: string) {
  if (error && typeof error === "object" && "value" in error) {
    const value = (error as { value?: unknown }).value;
    if (value && typeof value === "object" && "error" in value) {
      return String((value as { error: unknown }).error);
    }
  }
  return fallback;
}

function canManageMember(
  actorRole: WorkspaceMemberRole | undefined,
  target: WorkspaceMember,
) {
  if (target.role === "owner") return false;
  if (actorRole === "owner") return true;
  return actorRole === "admin" && target.role === "member";
}

export function WorkspaceManageRoute() {
  const token = useAuthStore((state) => state.token);
  const currentUser = useAuthStore((state) => state.user);
  const activeWorkspace = useWorkspacesStore((state) => state.activeWorkspace);
  const [ownedBots, setOwnedBots] = useState<Bot[]>([]);
  const [pendingBotInvites, setPendingBotInvites] = useState<
    BotWorkspaceInvite[]
  >([]);
  const [loadingManagementData, setLoadingManagementData] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [botId, setBotId] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [confirmingAction, setConfirmingAction] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const workspaceRefreshGeneration = useRef(0);
  const adminLoadGeneration = useRef(0);

  const actorRole = activeWorkspace?.members.find(
    (member) => member.userId === currentUser?.id,
  )?.role;
  const canManage = actorRole === "owner" || actorRole === "admin";
  const people = useMemo(
    () =>
      activeWorkspace?.members.filter((member) => member.user.type === "human") ??
      [],
    [activeWorkspace?.members],
  );
  const workspaceBots = useMemo(
    () =>
      activeWorkspace?.members.filter((member) => member.user.type === "bot") ??
      [],
    [activeWorkspace?.members],
  );
  const workspaceBotIds = useMemo(
    () => new Set(workspaceBots.flatMap((member) => (member.bot ? [member.bot.id] : []))),
    [workspaceBots],
  );
  const availableOwnedBots = ownedBots.filter((bot) => !workspaceBotIds.has(bot.id));

  const refreshWorkspace = useCallback(async () => {
    if (!token || !activeWorkspace) return;
    const requestedWorkspaceId = activeWorkspace.id;
    const requestGeneration = ++workspaceRefreshGeneration.current;
    const result = await api
      .workspaces({ id: requestedWorkspaceId })
      .get({ headers: authHeaders(token) });
    if (
      requestGeneration !== workspaceRefreshGeneration.current ||
      useWorkspacesStore.getState().activeWorkspace?.id !== requestedWorkspaceId
    ) {
      return;
    }
    if (result.error || !result.data) {
      throw new Error(apiError(result.error, "Failed to refresh workspace"));
    }
    useWorkspacesStore.setState({
      activeWorkspace: result.data as WorkspaceWithDetails,
    });
  }, [activeWorkspace?.id, token]);

  const loadAdminData = useCallback(async () => {
    const requestGeneration = ++adminLoadGeneration.current;
    const requestedWorkspaceId = activeWorkspace?.id;
    if (!token || !requestedWorkspaceId || !canManage) {
      setOwnedBots([]);
      setPendingBotInvites([]);
      return;
    }

    const [botsResult, pendingResult] = await Promise.all([
      api.bots.list.get({ headers: authHeaders(token) }),
      api
        .workspaces({ id: requestedWorkspaceId })["bot-invites"].get({
          headers: authHeaders(token),
        }),
    ]);
    if (
      requestGeneration !== adminLoadGeneration.current ||
      useWorkspacesStore.getState().activeWorkspace?.id !== requestedWorkspaceId
    ) {
      return;
    }
    if (botsResult.error) {
      throw new Error(apiError(botsResult.error, "Failed to load your bots"));
    }
    if (pendingResult.error) {
      throw new Error(
        apiError(pendingResult.error, "Failed to load bot approval requests"),
      );
    }
    setOwnedBots((botsResult.data ?? []) as Bot[]);
    setPendingBotInvites((pendingResult.data ?? []) as BotWorkspaceInvite[]);
  }, [activeWorkspace?.id, canManage, token]);

  useEffect(() => {
    let cancelled = false;
    setLoadingManagementData(true);
    setPageError(null);
    Promise.all([refreshWorkspace(), loadAdminData()])
      .catch((error) => {
        if (!cancelled) {
          setPageError(
            error instanceof Error
              ? error.message
              : "Failed to load workspace management",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingManagementData(false);
      });
    return () => {
      cancelled = true;
      workspaceRefreshGeneration.current += 1;
      adminLoadGeneration.current += 1;
    };
  }, [loadAdminData, refreshWorkspace]);

  useEffect(() => {
    if (!activeWorkspace) return;
    const handleResolved = ({ workspaceId }: { workspaceId: string }) => {
      if (workspaceId !== activeWorkspace.id) return;
      void Promise.all([refreshWorkspace(), loadAdminData()]).catch(() => undefined);
    };
    wsEvents.on("ws:bot_workspace_invite_resolved", handleResolved);
    return () => {
      wsEvents.off("ws:bot_workspace_invite_resolved", handleResolved);
    };
  }, [activeWorkspace?.id, loadAdminData, refreshWorkspace]);

  const runAction = async (key: string, action: () => Promise<void>) => {
    setBusyAction(key);
    setPageError(null);
    setStatusMessage(null);
    try {
      await action();
    } catch (error) {
      setPageError(
        error instanceof Error ? error.message : "Workspace update failed",
      );
    } finally {
      setBusyAction(null);
      setConfirmingAction(null);
    }
  };

  if (!activeWorkspace) {
    return (
      <div className="flex h-full items-center justify-center text-[0.929rem] text-text-muted">
        Select a workspace to manage.
      </div>
    );
  }

  const inviteUser = async () => {
    if (!token) return;
    const email = inviteEmail.trim();
    if (!email) return;
    const result = await api.invites.create.post(
      { workspaceId: activeWorkspace.id, email },
      { headers: authHeaders(token) },
    );
    if (result.error) {
      throw new Error(apiError(result.error, "Failed to invite user"));
    }
    setInviteEmail("");
    setStatusMessage(`Invitation sent to ${email}.`);
  };

  const updateRole = async (
    member: WorkspaceMember,
    role: "member" | "admin",
  ) => {
    if (!token) return;
    const result = await api
      .workspaces({ id: activeWorkspace.id })
      .members({ userId: member.userId })
      .role.post({ role }, { headers: authHeaders(token) });
    if (result.error) {
      throw new Error(apiError(result.error, "Failed to update member role"));
    }
    await refreshWorkspace();
    setStatusMessage(`${member.user.name} is now ${role}.`);
  };

  const removeUser = async (member: WorkspaceMember) => {
    if (!token) return;
    const result = await api
      .workspaces({ id: activeWorkspace.id })
      .members({ userId: member.userId })
      .delete(undefined, { headers: authHeaders(token) });
    if (result.error) {
      throw new Error(apiError(result.error, "Failed to remove workspace member"));
    }
    await refreshWorkspace();
    setStatusMessage(`${member.user.name} was removed from the workspace.`);
  };

  const addBot = async () => {
    if (!token) return;
    const requestedBotId = botId.trim();
    if (!requestedBotId) return;
    const result = await api
      .workspaces({ id: activeWorkspace.id })
      .bots.post(
        { botId: requestedBotId },
        { headers: authHeaders(token) },
      );
    if (result.error || !result.data) {
      throw new Error(apiError(result.error, "Failed to add bot"));
    }

    const outcome = result.data as BotWorkspaceInviteResult;
    setBotId("");
    if (outcome.status === "added") {
      await refreshWorkspace();
      setStatusMessage("Bot added to the workspace.");
    } else {
      await loadAdminData();
      setStatusMessage(
        `Approval requested from the owner of ${outcome.invite.botName}.`,
      );
    }
  };

  const cancelBotInvite = async (invite: BotWorkspaceInvite) => {
    if (!token) return;
    const result = await api
      .workspaces({ id: activeWorkspace.id })["bot-invites"]({
        inviteId: invite.id,
      })
      .delete(undefined, { headers: authHeaders(token) });
    if (result.error) {
      throw new Error(
        apiError(result.error, "Failed to cancel bot approval request"),
      );
    }
    await loadAdminData();
    setStatusMessage(`Request for ${invite.botName} was cancelled.`);
  };

  const removeBot = async (member: WorkspaceMember) => {
    if (!token || !member.bot) return;
    const result = await api
      .workspaces({ id: activeWorkspace.id })
      .bots({ botId: member.bot.id })
      .delete(undefined, { headers: authHeaders(token) });
    if (result.error) {
      throw new Error(apiError(result.error, "Failed to remove bot"));
    }
    await refreshWorkspace();
    setStatusMessage(`${member.user.name} was removed from the workspace.`);
  };

  const copyWorkspaceId = async () => {
    try {
      await navigator.clipboard.writeText(activeWorkspace.id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setPageError("Could not copy the workspace ID");
    }
  };

  return (
    <div className="flex h-full flex-col bg-base">
      <header className="border-b border-border px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-[1.071rem] font-semibold text-text">
              Manage {activeWorkspace.name}
            </h1>
            <p className="mt-1 text-[0.786rem] text-text-muted">
              People and bots with access to this workspace.
            </p>
          </div>
          <div className="min-w-0 rounded-lg border border-border bg-raised px-3 py-2">
            <div className="text-[0.643rem] font-semibold uppercase tracking-[0.08em] text-text-dimmed">
              Workspace ID
            </div>
            <div className="mt-1 flex items-center gap-2">
              <code
                data-testid="workspace-id"
                data-workspace-value={activeWorkspace.id}
                className="max-w-[280px] overflow-hidden text-ellipsis whitespace-nowrap text-[0.786rem] text-text-secondary"
              >
                {activeWorkspace.id}
              </code>
              <button
                type="button"
                className="cursor-pointer rounded px-1.5 py-0.5 text-[0.714rem] text-accent hover:bg-hover"
                onClick={() => void copyWorkspaceId()}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-5 py-5">
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          {(pageError || statusMessage) && (
            <div
              role={pageError ? "alert" : "status"}
              className={`rounded-lg border px-3 py-2 text-[0.857rem] ${
                pageError
                  ? "border-error-border bg-error-msg-bg text-error-bright"
                  : "border-success-border bg-success-bg text-success"
              }`}
            >
              {pageError ?? statusMessage}
            </div>
          )}

          {!canManage && (
            <div className="rounded-lg border border-border bg-raised px-3 py-2 text-[0.857rem] text-text-muted">
              You can view workspace access. Only workspace owners and admins can
              make changes.
            </div>
          )}

          <section aria-labelledby="workspace-people-heading">
            <div className="flex items-end justify-between gap-3">
              <div>
                <h2
                  id="workspace-people-heading"
                  className="text-[0.929rem] font-semibold text-text"
                >
                  People
                </h2>
                <p className="mt-0.5 text-[0.786rem] text-text-muted">
                  {people.length} {people.length === 1 ? "person" : "people"}
                </p>
              </div>
            </div>

            {canManage && (
              <form
                className="mt-3 rounded-lg border border-border bg-raised p-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void runAction("invite-user", inviteUser);
                }}
              >
                <label
                  htmlFor="workspace-invite-email"
                  className="text-[0.714rem] font-medium text-text-secondary"
                >
                  Invite by email
                </label>
                <div
                  data-testid="invite-user-controls"
                  className="mt-1 grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-x-2"
                >
                  <input
                    id="workspace-invite-email"
                    data-testid="invite-user-email"
                    aria-describedby="workspace-invite-email-help"
                    type="email"
                    required
                    value={inviteEmail}
                    onChange={(event) => setInviteEmail(event.target.value)}
                    placeholder="person@example.com"
                    className="w-full rounded-md border border-border bg-base px-2.5 py-2 text-[0.857rem] text-text outline-none placeholder:text-text-dimmed focus:border-accent sm:col-start-1 sm:row-start-1 sm:min-w-0"
                  />
                  <div
                    id="workspace-invite-email-help"
                    className="mt-1 text-[0.643rem] text-text-dimmed sm:col-start-1 sm:row-start-2"
                  >
                    The person must already have a TheChat account.
                  </div>
                  <button
                    data-testid="invite-user-submit"
                    type="submit"
                    disabled={busyAction === "invite-user"}
                    className="mt-2 w-full cursor-pointer rounded-md bg-accent px-3 py-2 text-[0.786rem] font-medium text-white disabled:cursor-not-allowed disabled:opacity-50 sm:col-start-2 sm:row-start-1 sm:mt-0 sm:w-auto sm:self-stretch"
                  >
                    {busyAction === "invite-user" ? "Inviting..." : "Invite"}
                  </button>
                </div>
              </form>
            )}

            <div className="mt-3 divide-y divide-border overflow-hidden rounded-lg border border-border bg-raised">
              {people.map((member) => {
                const manageable = canManageMember(actorRole, member);
                const removeKey = `remove-user:${member.userId}`;
                return (
                  <div
                    key={member.userId}
                    data-testid={`member-row-${member.userId}`}
                    className="flex flex-wrap items-center gap-3 px-3 py-3"
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-2.5">
                      <UserAvatar
                        name={member.user.name}
                        avatar={member.user.avatar}
                        size="md"
                      />
                      <div className="min-w-0">
                        <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[0.857rem] font-medium text-text">
                          {member.user.name}
                          {member.userId === currentUser?.id && (
                            <span className="ml-1.5 text-[0.714rem] font-normal text-text-dimmed">
                              You
                            </span>
                          )}
                        </div>
                        <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[0.714rem] text-text-muted">
                          {member.user.email ?? "No email"}
                        </div>
                      </div>
                    </div>

                    {manageable ? (
                      <select
                        aria-label={`Role for ${member.user.name}`}
                        value={member.role}
                        disabled={busyAction === `role:${member.userId}`}
                        className="rounded-md border border-border bg-base px-2 py-1.5 text-[0.786rem] text-text-secondary outline-none focus:border-accent"
                        onChange={(event) =>
                          void runAction(`role:${member.userId}`, () =>
                            updateRole(
                              member,
                              event.target.value as "member" | "admin",
                            ),
                          )
                        }
                      >
                        <option value="member">Member</option>
                        <option value="admin">Admin</option>
                      </select>
                    ) : (
                      <span className="rounded-md bg-base px-2 py-1 text-[0.714rem] capitalize text-text-muted">
                        {member.role}
                      </span>
                    )}

                    {manageable &&
                      (confirmingAction === removeKey ? (
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={busyAction === removeKey}
                            className="cursor-pointer rounded-md bg-error-msg-bg px-2 py-1.5 text-[0.714rem] font-medium text-error-bright"
                            onClick={() =>
                              void runAction(removeKey, () => removeUser(member))
                            }
                          >
                            Confirm
                          </button>
                          <button
                            type="button"
                            className="cursor-pointer rounded-md px-2 py-1.5 text-[0.714rem] text-text-muted hover:bg-hover"
                            onClick={() => setConfirmingAction(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="cursor-pointer rounded-md px-2 py-1.5 text-[0.714rem] text-error-bright hover:bg-error-msg-bg"
                          onClick={() => setConfirmingAction(removeKey)}
                        >
                          Remove
                        </button>
                      ))}
                  </div>
                );
              })}
            </div>
          </section>

          <section aria-labelledby="workspace-bots-heading">
            <div>
              <h2
                id="workspace-bots-heading"
                className="text-[0.929rem] font-semibold text-text"
              >
                Bots
              </h2>
              <p className="mt-0.5 text-[0.786rem] text-text-muted">
                {workspaceBots.length} {workspaceBots.length === 1 ? "bot" : "bots"}
              </p>
            </div>

            {canManage && (
              <form
                className="mt-3 rounded-lg border border-border bg-raised p-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void runAction("add-bot", addBot);
                }}
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                  <div className="min-w-0 flex-1">
                    <label
                      htmlFor="workspace-bot-id"
                      className="text-[0.714rem] font-medium text-text-secondary"
                    >
                      Bot ID
                    </label>
                    <input
                      id="workspace-bot-id"
                      data-testid="bot-id-input"
                      list="owned-bot-options"
                      required
                      value={botId}
                      onChange={(event) => setBotId(event.target.value)}
                      placeholder="Paste a bot ID"
                      className="mt-1 w-full rounded-md border border-border bg-base px-2.5 py-2 font-mono text-[0.786rem] text-text outline-none placeholder:font-sans placeholder:text-text-dimmed focus:border-accent"
                    />
                    <datalist id="owned-bot-options">
                      {availableOwnedBots.map((bot) => (
                        <option key={bot.id} value={bot.id}>
                          {bot.name}
                        </option>
                      ))}
                    </datalist>
                  </div>
                  <button
                    data-testid="add-bot-submit"
                    type="submit"
                    disabled={busyAction === "add-bot"}
                    className="cursor-pointer rounded-md bg-accent px-3 py-2 text-[0.786rem] font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {busyAction === "add-bot" ? "Adding..." : "Add bot"}
                  </button>
                </div>
                <p className="mt-2 text-[0.714rem] leading-relaxed text-text-muted">
                  Bots you own are added immediately. For any other bot, its owner
                  receives an approval notification first.
                </p>
                {availableOwnedBots.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <span className="py-1 text-[0.643rem] text-text-dimmed">
                      Your bots:
                    </span>
                    {availableOwnedBots.map((bot) => (
                      <button
                        key={bot.id}
                        type="button"
                        className="cursor-pointer rounded-full border border-border bg-base px-2 py-1 text-[0.643rem] text-text-secondary hover:border-accent hover:text-accent"
                        onClick={() => setBotId(bot.id)}
                      >
                        {bot.name}
                      </button>
                    ))}
                  </div>
                )}
              </form>
            )}

            <div className="mt-3 divide-y divide-border overflow-hidden rounded-lg border border-border bg-raised">
              {workspaceBots.length === 0 ? (
                <div className="px-3 py-5 text-center text-[0.786rem] text-text-muted">
                  No bots in this workspace.
                </div>
              ) : (
                workspaceBots.map((member) => {
                  const removeKey = `remove-bot:${member.userId}`;
                  const ownedByCurrentUser = Boolean(
                    member.bot && ownedBots.some((bot) => bot.id === member.bot?.id),
                  );
                  return (
                    <div
                      key={member.userId}
                      data-testid={
                        member.bot ? `bot-row-${member.bot.id}` : undefined
                      }
                      className="flex flex-wrap items-center gap-3 px-3 py-3"
                    >
                      <div className="flex min-w-0 flex-1 items-center gap-2.5">
                        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent-muted text-[0.714rem] font-bold text-accent">
                          BOT
                        </div>
                        <div className="min-w-0">
                          <div className="overflow-hidden text-ellipsis whitespace-nowrap text-[0.857rem] font-medium text-text">
                            {member.user.name}
                          </div>
                          <div className="font-mono text-[0.643rem] text-text-muted">
                            {member.bot?.id ?? member.userId}
                          </div>
                        </div>
                      </div>
                      <span className="rounded-md bg-base px-2 py-1 text-[0.714rem] text-text-muted">
                        {ownedByCurrentUser
                          ? "Owned by you"
                          : member.bot?.kind ?? "Bot"}
                      </span>
                      {canManage &&
                        (confirmingAction === removeKey ? (
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={busyAction === removeKey}
                              className="cursor-pointer rounded-md bg-error-msg-bg px-2 py-1.5 text-[0.714rem] font-medium text-error-bright"
                              onClick={() =>
                                void runAction(removeKey, () => removeBot(member))
                              }
                            >
                              Confirm
                            </button>
                            <button
                              type="button"
                              className="cursor-pointer rounded-md px-2 py-1.5 text-[0.714rem] text-text-muted hover:bg-hover"
                              onClick={() => setConfirmingAction(null)}
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="cursor-pointer rounded-md px-2 py-1.5 text-[0.714rem] text-error-bright hover:bg-error-msg-bg"
                            onClick={() => setConfirmingAction(removeKey)}
                          >
                            Remove
                          </button>
                        ))}
                    </div>
                  );
                })
              )}
            </div>

            {canManage && pendingBotInvites.length > 0 && (
              <div className="mt-3">
                <h3 className="text-[0.786rem] font-medium text-text-secondary">
                  Waiting for approval
                </h3>
                <div className="mt-2 divide-y divide-border overflow-hidden rounded-lg border border-border bg-raised">
                  {pendingBotInvites.map((invite) => (
                    <div
                      key={invite.id}
                      data-testid={`pending-bot-request-${invite.id}`}
                      className="flex flex-wrap items-center gap-3 px-3 py-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-[0.786rem] font-medium text-text">
                          {invite.botName}
                        </div>
                        <div className="mt-0.5 font-mono text-[0.643rem] text-text-muted">
                          {invite.botId}
                        </div>
                        <div className="mt-1 text-[0.714rem] text-text-dimmed">
                          The bot owner has been notified.
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={busyAction === `cancel-bot:${invite.id}`}
                        className="cursor-pointer rounded-md px-2 py-1.5 text-[0.714rem] text-text-muted hover:bg-hover hover:text-text"
                        onClick={() =>
                          void runAction(`cancel-bot:${invite.id}`, () =>
                            cancelBotInvite(invite),
                          )
                        }
                      >
                        Cancel request
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>

          {loadingManagementData && (
            <div className="text-center text-[0.714rem] text-text-dimmed">
              Refreshing workspace access...
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
