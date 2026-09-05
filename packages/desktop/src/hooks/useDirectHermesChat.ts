import { useEffect, useMemo, useSyncExternalStore } from "react";
import { api } from "../lib/api";
import { DirectHermesChat } from "../lib/direct-hermes-chat";
import type { DirectHermesProxyTicket } from "../lib/direct-hermes-gateway";
import { authHeaders, edenErrorMessage } from "../lib/eden";
import { useAuthStore } from "../stores/auth";

// One controller per authenticated bot/DM, not per mounted view. Switching
// routes must not stop a turn or lose events/drafts. Nothing is persisted.
const chats = new Map<string, { token: string | null; chat: DirectHermesChat }>();
export function clearDirectHermesChats() {
  chats.forEach(({ chat }) => chat.dispose());
  chats.clear();
}
useAuthStore.subscribe((state, previous) => {
  if (state.token !== previous.token) clearDirectHermesChats();
});

export function useDirectHermesChat(botId: string, conversationId: string, token: string | null) {
  const chat = useMemo(() => {
    const key = JSON.stringify([botId, conversationId]);
    const existing = chats.get(key);
    if (existing?.token === token) return existing.chat;
    existing?.chat.dispose();
    const controller = new DirectHermesChat({
      issueTicket: async signal => {
        if (!token) throw new Error("Sign in to connect to Hermes.");
        const { data, error } = await api.bots({ botId })["hermes-rpc"]["proxy-ticket"].post(
          { conversationId }, { ...authHeaders(token), fetch: { signal } },
        );
        if (error) throw new Error(edenErrorMessage(error, "Hermes proxy is unavailable"));
        // Eden's success union includes framework error bodies; the transport
        // validates the actual grant (including ISO strings and revived Dates).
        return data as DirectHermesProxyTicket;
      },
    });
    chats.set(key, { token, chat: controller });
    return controller;
  }, [botId, conversationId, token]);
  const state = useSyncExternalStore(chat.subscribe, chat.getSnapshot);
  useEffect(() => { if (token && chat.getSnapshot().connection === "idle") void chat.connect(); }, [chat, token]);
  return { chat, state };
}
