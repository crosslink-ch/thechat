import { useMemo } from "react";
import {
  defaultBotAppearance,
  type BotAppearance,
  type WorkspaceMember,
} from "@thechat/shared";
import { useWorkspacesStore } from "../stores/workspaces";

/** A bot's appearance, or its default when the payload predates avatars. */
export function botAppearanceFor(
  botUserId: string,
  avatar?: BotAppearance | null,
): BotAppearance {
  return avatar ?? defaultBotAppearance(botUserId);
}

// One lookup per member list, shared by every row that reads it; the store
// replaces the list on change, so a stale map is never reused.
const avatarsByMembers = new WeakMap<WorkspaceMember[], Map<string, BotAppearance>>();

/** Saved bot appearances in a member list, by the bot's user id. */
export function botAvatarsOf(members: WorkspaceMember[]) {
  let avatars = avatarsByMembers.get(members);
  if (!avatars) {
    avatars = new Map();
    for (const member of members) {
      if (member.bot?.avatar) avatars.set(member.userId, member.bot.avatar);
    }
    avatarsByMembers.set(members, avatars);
  }
  return avatars;
}

/**
 * A bot's appearance by its user id, read from the active workspace's members
 * so a change the owner makes shows on every earlier message too.
 */
export function useBotAppearance(botUserId: string | null | undefined) {
  const avatar = useWorkspacesStore((state) => {
    const members = state.activeWorkspace?.members;
    return botUserId && members ? botAvatarsOf(members).get(botUserId) : undefined;
  });
  return useMemo(
    () => (botUserId ? botAppearanceFor(botUserId, avatar) : null),
    [botUserId, avatar],
  );
}
