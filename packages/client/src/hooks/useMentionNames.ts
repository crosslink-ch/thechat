import { useCallback, useMemo } from "react";
import type { ChatMessage } from "@thechat/shared";
import { useAuthStore } from "../stores/auth";
import type { MentionUser } from "../components/MentionList";
import { messageMentionsUser, type MentionNames } from "../lib/remark-mentions";

/**
 * Mention rendering context for a message list: who can be a pill (and their
 * current names) and whether a message mentions the signed-in user.
 */
export function useMentionNames(mentions: MentionUser[] | undefined) {
  const selfId = useAuthStore((state) => state.user?.id ?? null);
  const selfName = useAuthStore((state) => state.user?.name ?? null);
  const mentionNames = useMemo<MentionNames>(
    () => ({
      names: (mentions ?? []).map((mention) => mention.label),
      self: selfName,
      selfId,
      labels: new Map([
        ...(mentions ?? []).map((mention) => [mention.id, mention.label] as const),
        ...(selfId && selfName ? [[selfId, selfName] as const] : []),
      ]),
    }),
    [mentions, selfId, selfName],
  );
  const mentionsYou = useCallback(
    (message: Pick<ChatMessage, "senderId" | "content" | "contentFormat" | "parts">) =>
      message.senderId !== selfId &&
      messageMentionsUser(message, { id: selfId, name: selfName }),
    [selfId, selfName],
  );
  return { mentionNames, mentionsYou };
}
