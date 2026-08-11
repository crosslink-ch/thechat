import { useMemo } from "react";
import { closePaletteAndRefocus } from "../CommandPalette";
import type { Command } from "../commands";
import {
  needsAttentionScopeKey,
  useNeedsAttentionStore,
} from "../stores/needs-attention";
import { useScopedCommands } from "./useScopedCommands";

export const NEEDS_ATTENTION_SHORTCUT = "C-x !";

export function useNeedsAttentionCommand({
  userId,
  conversationId,
  threadId = null,
}: {
  userId: string | null | undefined;
  conversationId: string;
  threadId?: string | null;
}) {
  const scopeKey = needsAttentionScopeKey(conversationId, threadId);
  const marked = useNeedsAttentionStore((state) => Boolean(state.scopes[scopeKey]));
  const ready = useNeedsAttentionStore(
    (state) => state.initialized && state.activeUserId === userId,
  );
  const toggle = useNeedsAttentionStore((state) => state.toggle);

  const commands = useMemo<Command[]>(
    () => [
      {
        id: "needs-attention",
        label: marked ? "Clear Needs Attention" : "Needs Attention",
        shortcut: NEEDS_ATTENTION_SHORTCUT,
        keybinding: { prefix: "C-x", key: "!" },
        enabled: Boolean(userId) && ready,
        priority: 90,
        execute: () => {
          void toggle({ conversationId, threadId });
          closePaletteAndRefocus();
        },
      },
    ],
    [conversationId, marked, ready, threadId, toggle, userId],
  );

  useScopedCommands(commands);
  return marked;
}
