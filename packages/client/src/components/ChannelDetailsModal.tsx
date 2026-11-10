import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { create } from "zustand";
import type {
  ConversationParticipantPublic,
  WorkspaceMember,
} from "@thechat/shared";
import { Archive, ArchiveRestore, Hash, Lock, Pencil, Trash2, UserPlus, X } from "lucide-react";
import { useAuthStore } from "../stores/auth";
import { useWorkspacesStore } from "../stores/workspaces";
import {
  conversationDetailQueryKey,
  useConversationDetail,
} from "../hooks/useConversationDetail";
import { botAppearanceFor } from "../lib/bot-appearance";
import { onSessionReset } from "../lib/session-boundary";
import { Avatar } from "./Avatar";
import { openDeleteChannelModal, openRenameChannelModal } from "./ChannelModal";
import {
  buttonClass,
  dialogContentClass,
  dialogOverlayClass,
  dialogTitleClass,
  iconButtonClass,
  inputClass,
} from "./ui";

// Colocated visibility store: the channel whose details are open.
const useChannelDetailsState = create(() => ({
  channelId: null as string | null,
}));
export const openChannelDetailsModal = (channelId: string) =>
  useChannelDetailsState.setState({ channelId });
export const closeChannelDetailsModal = () =>
  useChannelDetailsState.setState({ channelId: null });
onSessionReset(closeChannelDetailsModal);

const badgeClass =
  "inline-flex shrink-0 items-center gap-1 rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[0.714rem] font-medium text-text-muted";

function roleLabel(participant: ConversationParticipantPublic) {
  if (participant.user.type === "bot") return "Bot";
  if (participant.role === "owner") return "Owner";
  if (participant.role === "admin") return "Admin";
  return "Member";
}

/** Shown in place of the composer of an archived channel. */
export function ArchivedChannelNotice({ onOpenDetails }: { onOpenDetails: () => void }) {
  return (
    <div
      role="status"
      data-testid="archived-channel-notice"
      className="mx-5 mb-4 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-surface px-3.5 py-3 text-[0.857rem] text-text-muted"
    >
      <Archive size={15} aria-hidden="true" className="shrink-0 text-text-dimmed" />
      <span className="min-w-0 flex-1 basis-48">
        This channel is archived. You can read and search its history, but not post.
      </span>
      <button type="button" className={buttonClass("secondary", "sm")} onClick={onOpenDetails}>
        Channel details
      </button>
    </div>
  );
}

export function ChannelDetailsModal() {
  const channelId = useChannelDetailsState((state) => state.channelId);
  const channel = useWorkspacesStore((state) =>
    channelId
      ? state.activeWorkspace?.channels.find((item) => item.id === channelId)
      : undefined,
  );

  // The channel was deleted, or this person was removed from it.
  useEffect(() => {
    if (channelId && !channel) closeChannelDetailsModal();
  }, [channel, channelId]);

  if (!channelId || !channel) return null;
  return <ChannelDetails key={channelId} channelId={channelId} />;
}

function ChannelDetails({ channelId }: { channelId: string }) {
  const queryClient = useQueryClient();
  const token = useAuthStore((state) => state.token);
  const currentUserId = useAuthStore((state) => state.user?.id);
  const workspace = useWorkspacesStore((state) => state.activeWorkspace);
  const setChannelArchived = useWorkspacesStore((state) => state.setChannelArchived);
  const addChannelMembers = useWorkspacesStore((state) => state.addChannelMembers);
  const removeChannelMember = useWorkspacesStore((state) => state.removeChannelMember);
  const channel = workspace?.channels.find((item) => item.id === channelId);
  const detail = useConversationDetail(channelId, token);
  const refetchDetail = detail.refetch;

  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState("");
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  // The cached member list may predate changes made while this was closed.
  useEffect(() => {
    void refetchDetail();
  }, [refetchDetail]);

  const participants = detail.data?.participants;
  const participantIds = useMemo(
    () => new Set((participants ?? []).map((participant) => participant.userId)),
    [participants],
  );
  const myRole = workspace?.members.find((member) => member.userId === currentUserId)?.role;
  // The server rule: a workspace owner or admin who is in the channel.
  const canManage = myRole === "owner" || myRole === "admin";
  const isPrivate = channel?.isPrivate ?? false;
  const archived = Boolean(channel?.archivedAt);

  const candidates = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return (workspace?.members ?? []).filter(
      (member: WorkspaceMember) =>
        !participantIds.has(member.userId) &&
        (!query ||
          member.user.name.toLowerCase().includes(query) ||
          (member.user.email ?? "").toLowerCase().includes(query)),
    );
  }, [filter, participantIds, workspace?.members]);

  if (!channel) return null;

  const refreshMembers = () =>
    queryClient.invalidateQueries({ queryKey: conversationDetailQueryKey(channelId) });

  async function run(action: string, work: () => Promise<void>) {
    if (busy) return;
    setBusy(action);
    setError("");
    try {
      await work();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  }

  const canRemove = (participant: ConversationParticipantPublic) =>
    canManage &&
    isPrivate &&
    participant.userId !== currentUserId &&
    participant.role !== "owner" &&
    !(myRole === "admin" && participant.role === "admin");

  const closeAddPicker = () => {
    setAdding(false);
    setFilter("");
    setPicked(new Set());
  };

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
          aria-describedby={undefined}
          data-testid="channel-details"
          className={`fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-[520px] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden ${dialogContentClass}`}
        >
          <div className="flex items-start gap-3 px-5 pb-3 pt-5">
            <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
              {isPrivate ? <Lock size={18} aria-hidden="true" /> : <Hash size={18} aria-hidden="true" />}
            </div>
            <div className="min-w-0 flex-1">
              <Dialog.Title asChild>
                <h2 className={`truncate ${dialogTitleClass}`}>{channel.name}</h2>
              </Dialog.Title>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <span className={badgeClass} data-testid="channel-visibility">
                  {isPrivate ? "Private channel" : "Public channel"}
                </span>
                {archived && (
                  <span className={badgeClass} data-testid="channel-archived-badge">
                    <Archive size={11} aria-hidden="true" />
                    Archived
                  </span>
                )}
              </div>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                disabled={Boolean(busy)}
                className={`-mr-1.5 -mt-1 ${iconButtonClass("md")}`}
                aria-label="Close channel details"
              >
                <X size={16} aria-hidden="true" />
              </button>
            </Dialog.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
            <section aria-label="Members">
              <div className="mb-1.5 flex items-center justify-between gap-3">
                <h3 className="text-[0.857rem] font-medium text-text-secondary">
                  Members
                  {participants && (
                    <span className="ml-1.5 text-text-dimmed">{participants.length}</span>
                  )}
                </h3>
                {canManage && isPrivate && !adding && (
                  <button
                    type="button"
                    className={buttonClass("secondary", "sm")}
                    onClick={() => setAdding(true)}
                  >
                    <UserPlus size={14} aria-hidden="true" />
                    Add people
                  </button>
                )}
              </div>

              {adding && (
                <form
                  aria-label="Add people"
                  className="mb-3 rounded-lg border border-border bg-base p-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (picked.size === 0) return;
                    void run("add", async () => {
                      await addChannelMembers(channelId, [...picked]);
                      await refreshMembers();
                      closeAddPicker();
                    });
                  }}
                >
                  <input
                    autoFocus
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                    placeholder="Search workspace members"
                    aria-label="Search workspace members"
                    className={inputClass}
                  />
                  <div className="mt-2 max-h-40 overflow-y-auto">
                    {candidates.length === 0 ? (
                      <p className="px-1 py-2 text-[0.786rem] text-text-placeholder">
                        {filter.trim()
                          ? "No one matches."
                          : "Everyone in the workspace is already in this channel."}
                      </p>
                    ) : (
                      candidates.map((member) => (
                        <label
                          key={member.userId}
                          className="flex cursor-pointer items-center gap-3 rounded-md px-1 py-1.5 hover:bg-hover/70"
                        >
                          <input
                            type="checkbox"
                            className="size-3.5 shrink-0 rounded accent-accent"
                            checked={picked.has(member.userId)}
                            disabled={Boolean(busy)}
                            aria-label={`Add ${member.user.name}`}
                            onChange={(event) => {
                              const include = event.target.checked;
                              setPicked((current) => {
                                const next = new Set(current);
                                if (include) next.add(member.userId);
                                else next.delete(member.userId);
                                return next;
                              });
                            }}
                          />
                          <Avatar
                            name={member.user.name}
                            colorKey={member.userId}
                            bot={member.user.type === "bot"}
                            botAvatar={
                              member.user.type === "bot"
                                ? botAppearanceFor(member.userId, member.bot?.avatar)
                                : null
                            }
                            size={24}
                            className="size-6 text-[0.714rem]"
                          />
                          <span className="min-w-0 flex-1 truncate text-[0.857rem] text-text">
                            {member.user.name}
                          </span>
                          <span className="shrink-0 text-[0.75rem] text-text-placeholder">
                            {member.user.type === "bot" ? "Bot" : null}
                          </span>
                        </label>
                      ))
                    )}
                  </div>
                  <div className="mt-3 flex justify-end gap-2">
                    <button
                      type="button"
                      className={buttonClass("ghost", "sm")}
                      disabled={Boolean(busy)}
                      onClick={closeAddPicker}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className={buttonClass("primary", "sm")}
                      disabled={picked.size === 0 || Boolean(busy)}
                    >
                      {busy === "add"
                        ? "Adding..."
                        : picked.size > 1
                          ? `Add ${picked.size} people`
                          : "Add"}
                    </button>
                  </div>
                </form>
              )}

              {!participants ? (
                <p className="py-3 text-[0.857rem] text-text-placeholder">
                  {detail.isError ? "Could not load members." : "Loading members..."}
                </p>
              ) : (
                <ul className="overflow-hidden rounded-lg border border-border bg-base" data-testid="channel-members">
                  {participants.map((participant) => {
                    const isBot = participant.user.type === "bot";
                    return (
                      <li
                        key={participant.userId}
                        className="flex items-center gap-3 border-b border-border/70 px-3 py-2 last:border-b-0"
                      >
                        <Avatar
                          name={participant.user.name}
                          colorKey={participant.userId}
                          bot={isBot}
                          botAvatar={
                            isBot
                              ? botAppearanceFor(participant.userId, participant.bot?.avatar)
                              : null
                          }
                          size={28}
                          className="size-7 text-[0.786rem]"
                        />
                        <span className="min-w-0 flex-1 truncate text-[0.857rem] font-medium text-text">
                          {participant.user.name}
                          {participant.userId === currentUserId && (
                            <span className="font-normal text-text-dimmed"> (you)</span>
                          )}
                        </span>
                        <span data-member-role className="shrink-0 text-[0.786rem] text-text-muted">
                          {roleLabel(participant)}
                        </span>
                        {canManage && isPrivate && (
                          // The same slot in every row keeps the role column
                          // aligned (touch layouts widen dialog buttons to 44px).
                          <span className="flex w-11 shrink-0 items-center justify-end max-lg:h-11">
                            {canRemove(participant) && (
                              <button
                                type="button"
                                className={iconButtonClass("sm")}
                                disabled={Boolean(busy)}
                                aria-label={`Remove ${participant.user.name}`}
                                title={`Remove ${participant.user.name} from this channel`}
                                onClick={() =>
                                  void run(`remove:${participant.userId}`, async () => {
                                    await removeChannelMember(channelId, participant.userId);
                                    await refreshMembers();
                                  })
                                }
                              >
                                <X size={14} aria-hidden="true" />
                              </button>
                            )}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="mt-2 text-[0.75rem] leading-4 text-text-placeholder">
                {isPrivate
                  ? "Only these members can see and open this channel."
                  : "Everyone in the workspace is in a public channel."}
              </p>
            </section>

            {error && (
              <p role="alert" className="mt-3 text-[0.786rem] text-error-bright">
                {error}
              </p>
            )}

            {canManage && (
              <section aria-label="Manage channel" className="mt-5 border-t border-border pt-4">
                <h3 className="mb-2 text-[0.857rem] font-medium text-text-secondary">Manage</h3>
                <div className="flex flex-wrap gap-2">
                  {!archived && (
                    <button
                      type="button"
                      className={buttonClass("secondary", "sm")}
                      disabled={Boolean(busy)}
                      onClick={() => {
                        closeChannelDetailsModal();
                        openRenameChannelModal(channel);
                      }}
                    >
                      <Pencil size={14} aria-hidden="true" />
                      Rename
                    </button>
                  )}
                  <button
                    type="button"
                    className={buttonClass("secondary", "sm")}
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void run("archive", async () => {
                        await setChannelArchived(channelId, !archived);
                      })
                    }
                  >
                    {archived ? (
                      <ArchiveRestore size={14} aria-hidden="true" />
                    ) : (
                      <Archive size={14} aria-hidden="true" />
                    )}
                    {archived ? "Unarchive" : "Archive"}
                  </button>
                  <button
                    type="button"
                    className={buttonClass("danger-soft", "sm")}
                    disabled={Boolean(busy)}
                    onClick={() => {
                      closeChannelDetailsModal();
                      openDeleteChannelModal(channel);
                    }}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                    Delete
                  </button>
                </div>
                <p className="mt-2 text-[0.75rem] leading-4 text-text-placeholder">
                  {archived
                    ? "Archived channels are read-only and stay searchable. Unarchive to post again."
                    : "Archiving makes the channel read-only and moves it out of the channel list. Its history stays readable and searchable. Deleting is permanent."}
                </p>
              </section>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
