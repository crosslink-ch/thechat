import { useEffect, useState, useSyncExternalStore } from "react";
import { useMatches, useNavigate } from "@tanstack/react-router";
import * as Dialog from "@radix-ui/react-dialog";
import type { ChannelMemberRole, WorkspaceMember } from "@thechat/shared";
import { Hash, Lock, UserPlus, X } from "lucide-react";
import { useWorkspacesStore } from "../stores/workspaces";
import { useConversationsStore } from "../stores/conversations";
import { useAuthStore } from "../stores/auth";
import { channelAccess } from "../lib/channel-access";
import { botAppearanceFor } from "../lib/bot-appearance";
import { Avatar } from "./Avatar";
import { openDeleteChannelModal, openRenameChannelModal } from "./ChannelModal";
import { buttonClass, dialogContentClass, dialogOverlayClass, dialogTitleClass, iconButtonClass } from "./ui";

type Confirmation = "leave" | "visibility";
type DetailsState = { channelId: string; confirm: Confirmation | null };

let detailsState: DetailsState | null = null;
let focusReturnTarget: HTMLElement | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

/** Opens the channel's details: who is in it, and the controls to manage it. */
export function openChannelDetailsModal(
  channelId: string,
  options: { confirm?: Confirmation } = {},
) {
  focusReturnTarget =
    document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null;
  detailsState = { channelId, confirm: options.confirm ?? null };
  emit();
}

export function closeChannelDetailsModal() {
  detailsState = null;
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => detailsState;

const sectionTitleClass = "text-[0.857rem] font-medium text-text-secondary";
const noteClass = "text-[0.786rem] leading-5 text-text-placeholder";
const panelClass = "rounded-lg border border-border bg-base px-3.5 py-3";

export function ChannelDetailsModal() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const navigate = useNavigate();
  const matches = useMatches();
  const activeChannelId = matches
    .map((match) => (match.params as Record<string, string>).id)
    .find(Boolean);
  const activeWorkspace = useWorkspacesStore((store) => store.activeWorkspace);
  const currentUserId = useAuthStore((store) => store.user?.id);
  const channel = state
    ? activeWorkspace?.channels.find((item) => item.id === state.channelId) ?? null
    : null;
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setConfirm(state?.confirm ?? null);
    setAdding(false);
    setSelected(new Set());
    setBusy(false);
    setError("");
  }, [state]);

  // The channel was deleted, or this person is no longer in it.
  useEffect(() => {
    if (state && activeWorkspace && !channel) closeChannelDetailsModal();
  }, [activeWorkspace, channel, state]);

  if (!state || !channel || !activeWorkspace) return <Dialog.Root open={false} />;

  const access = channelAccess(channel, activeWorkspace.members, currentUserId);
  const byId = new Map(activeWorkspace.members.map((member) => [member.userId, member]));
  const rows: Array<{ userId: string; role: ChannelMemberRole; member: WorkspaceMember | undefined }> =
    channel.isPrivate
      ? (channel.members ?? []).map((entry) => ({ ...entry, member: byId.get(entry.userId) }))
      : activeWorkspace.members.map((member) => ({ userId: member.userId, role: "member", member }));
  const candidates = channel.isPrivate
    ? activeWorkspace.members.filter(
        (member) => !channel.members?.some((entry) => entry.userId === member.userId),
      )
    : [];
  const people = rows.filter((row) => row.member?.user.type !== "bot");
  const lastPerson = people.length === 1 && people[0]!.userId === currentUserId;
  const Icon = channel.isPrivate ? Lock : Hash;

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  const store = () => useWorkspacesStore.getState();

  const leave = () =>
    run(async () => {
      const channelId = channel.id;
      await store().removeChannelMember(channelId, currentUserId!);
      useConversationsStore.getState().markChannelRead(channelId);
      closeChannelDetailsModal();
      if (activeChannelId !== channelId) return;
      const channels = store().activeWorkspace?.channels ?? [];
      const next = channels.find((item) => item.name === "general") ?? channels[0];
      await navigate(next ? { to: "/channel/$id", params: { id: next.id } } : { to: "/" });
    });

  const changeVisibility = () =>
    run(async () => {
      await store().setChannelVisibility(channel.id, !channel.isPrivate);
      setConfirm(null);
    });

  const addSelected = () =>
    run(async () => {
      await store().addChannelMembers(channel.id, [...selected]);
      setSelected(new Set());
      setAdding(false);
    });

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) closeChannelDetailsModal();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={`z-50 ${dialogOverlayClass}`} />
        <Dialog.Content
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = focusReturnTarget;
            focusReturnTarget = null;
            if (target?.isConnected) target.focus();
          }}
          className={`fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[520px] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden ${dialogContentClass}`}
        >
          <div className="flex items-start gap-3 px-5 pb-4 pt-5">
            <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
              <Icon size={18} aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <Dialog.Title asChild>
                <h2 className={`truncate ${dialogTitleClass}`}>{channel.name}</h2>
              </Dialog.Title>
              <Dialog.Description asChild>
                <p className="mt-1 text-[0.857rem] leading-5 text-text-muted">
                  {channel.isPrivate
                    ? "Private channel. Only its members can see and open it."
                    : "Public channel. Everyone in the workspace can see and open it."}
                </p>
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                disabled={busy}
                className={`-mr-1.5 -mt-1 ${iconButtonClass("md")}`}
                aria-label="Close channel details"
              >
                <X size={16} aria-hidden="true" />
              </button>
            </Dialog.Close>
          </div>

          <div className="min-h-0 space-y-5 overflow-y-auto px-5 pb-5 pt-1">
            {error && (
              <p role="alert" className="text-[0.786rem] text-error-bright">
                {error}
              </p>
            )}

            {confirm === "leave" ? (
              <section className={panelClass} aria-label="Leave channel">
                <p className="text-[0.857rem] leading-5 text-text-secondary">
                  {lastPerson
                    ? "You are the last person in this channel. Leaving deletes it together with its messages."
                    : "You will no longer see this channel or its messages. Someone in it can add you back."}
                </p>
                <div className="mt-3 flex justify-end gap-2">
                  <button type="button" disabled={busy} className={buttonClass("ghost", "md")} onClick={() => setConfirm(null)}>
                    Cancel
                  </button>
                  <button type="button" disabled={busy} className={buttonClass("danger", "md")} onClick={leave}>
                    {busy ? "Leaving..." : lastPerson ? "Leave and delete" : "Leave channel"}
                  </button>
                </div>
              </section>
            ) : confirm === "visibility" ? (
              <section className={panelClass} aria-label="Change visibility">
                <p className="text-[0.857rem] leading-5 text-text-secondary">
                  {channel.isPrivate
                    ? "Everyone in the workspace will be added and can read all messages in this channel, including earlier ones."
                    : "Only the people in the channel now keep access. People who join the workspace later are not added."}
                </p>
                <div className="mt-3 flex justify-end gap-2">
                  <button type="button" disabled={busy} className={buttonClass("ghost", "md")} onClick={() => setConfirm(null)}>
                    Cancel
                  </button>
                  <button type="button" disabled={busy} className={buttonClass("primary", "md")} onClick={changeVisibility}>
                    {busy ? "Saving..." : channel.isPrivate ? "Make public" : "Make private"}
                  </button>
                </div>
              </section>
            ) : (
              (access.canManage || access.canLeave) && (
                <section aria-label="Channel settings">
                  <h3 className={sectionTitleClass}>Settings</h3>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {access.canManage && (
                      <button
                        type="button"
                        className={buttonClass("secondary", "md")}
                        onClick={() => {
                          closeChannelDetailsModal();
                          openRenameChannelModal(channel);
                        }}
                      >
                        Rename
                      </button>
                    )}
                    {access.canManage && (channel.isPrivate || channel.name !== "general") && (
                      <button type="button" className={buttonClass("secondary", "md")} onClick={() => setConfirm("visibility")}>
                        {channel.isPrivate ? "Make public" : "Make private"}
                      </button>
                    )}
                    {access.canLeave && (
                      <button type="button" className={buttonClass("secondary", "md")} onClick={() => setConfirm("leave")}>
                        Leave channel
                      </button>
                    )}
                    {access.canManage && (
                      <button
                        type="button"
                        className={buttonClass("danger-soft", "md")}
                        onClick={() => {
                          closeChannelDetailsModal();
                          openDeleteChannelModal(channel);
                        }}
                      >
                        Delete channel
                      </button>
                    )}
                  </div>
                </section>
              )
            )}

            <section aria-label="Members">
              <div className="flex items-center justify-between gap-3">
                <h3 className={sectionTitleClass}>
                  Members <span className="font-normal text-text-placeholder">{rows.length}</span>
                </h3>
                {access.canAddMembers && !adding && (
                  <button
                    type="button"
                    className={buttonClass("secondary", "sm")}
                    onClick={() => {
                      setAdding(true);
                      setError("");
                    }}
                  >
                    <UserPlus size={14} aria-hidden="true" />
                    Add people
                  </button>
                )}
              </div>

              {adding && (
                <div className={`mt-2 ${panelClass}`}>
                  {candidates.length === 0 ? (
                    <p className={noteClass}>Everyone in the workspace is already in this channel.</p>
                  ) : (
                    <ul className="max-h-40 overflow-y-auto">
                      {candidates.map((member) => (
                        <li key={member.userId}>
                          <label className="flex cursor-pointer items-center gap-3 rounded-md px-1 py-1.5 hover:bg-hover/70">
                            <input
                              type="checkbox"
                              className="size-3.5 shrink-0 rounded accent-accent"
                              checked={selected.has(member.userId)}
                              disabled={busy}
                              aria-label={`Add ${member.user.name}`}
                              onChange={(event) => {
                                const include = event.target.checked;
                                setSelected((current) => {
                                  const next = new Set(current);
                                  if (include) next.add(member.userId);
                                  else next.delete(member.userId);
                                  return next;
                                });
                              }}
                            />
                            <span className="min-w-0 flex-1 truncate text-[0.857rem] text-text">{member.user.name}</span>
                            {member.user.type === "bot" && <span className={noteClass}>Bot</span>}
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className={`mt-2 ${noteClass}`}>People you add can read all messages in this channel, including earlier ones.</p>
                  <div className="mt-3 flex justify-end gap-2">
                    <button type="button" disabled={busy} className={buttonClass("ghost", "md")} onClick={() => setAdding(false)}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={busy || selected.size === 0}
                      className={buttonClass("primary", "md")}
                      onClick={addSelected}
                    >
                      {busy ? "Adding..." : selected.size > 1 ? `Add ${selected.size} people` : "Add"}
                    </button>
                  </div>
                </div>
              )}

              <ul className="mt-2 divide-y divide-border/70 rounded-lg border border-border bg-base">
                {rows.map(({ userId, role, member }) => {
                  const name = member?.user.name ?? "Unknown member";
                  const isSelf = userId === currentUserId;
                  const isBot = member?.user.type === "bot";
                  const manageable = channel.isPrivate && access.canManage && !isSelf;
                  return (
                    <li key={userId} className="flex items-center gap-3 px-3 py-2">
                      <Avatar
                        name={name}
                        colorKey={userId}
                        bot={isBot}
                        botAvatar={isBot ? botAppearanceFor(userId, member?.bot?.avatar) : undefined}
                        size={28}
                        className="size-7 rounded-md text-[0.75rem]"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[0.857rem] font-medium text-text">
                          {name}
                          {isSelf ? " (you)" : ""}
                        </span>
                        <span className="block truncate text-[0.75rem] text-text-placeholder">
                          {isBot ? "Bot" : role === "admin" ? "Channel admin" : member?.user.email ?? "Member"}
                        </span>
                      </span>
                      {manageable && !isBot && (
                        <button
                          type="button"
                          disabled={busy}
                          className={buttonClass("ghost", "sm")}
                          aria-label={role === "admin" ? `Remove ${name} as channel admin` : `Make ${name} a channel admin`}
                          onClick={() =>
                            run(async () => {
                              await store().setChannelMemberRole(channel.id, userId, role === "admin" ? "member" : "admin");
                            })
                          }
                        >
                          {role === "admin" ? "Remove admin" : "Make admin"}
                        </button>
                      )}
                      {manageable && (
                        <button
                          type="button"
                          disabled={busy}
                          className={buttonClass("ghost", "sm")}
                          aria-label={`Remove ${name} from channel`}
                          onClick={() =>
                            run(async () => {
                              await store().removeChannelMember(channel.id, userId);
                            })
                          }
                        >
                          Remove
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
              {!channel.isPrivate && (
                <p className={`mt-2 ${noteClass}`}>
                  A public channel always includes everyone in the workspace.
                </p>
              )}
            </section>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
