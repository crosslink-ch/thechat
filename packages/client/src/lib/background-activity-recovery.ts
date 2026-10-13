import { api } from "./api";
import { authHeaders } from "./eden";
import { isAuthenticated } from "./auth-identity";
import { useAuthStore } from "../stores/auth";
import { useWorkspacesStore } from "../stores/workspaces";
import { useConversationsStore } from "../stores/conversations";
import { useHermesIndicatorsStore } from "../stores/hermes-indicators";
import { useHermesApprovalsStore } from "../stores/hermes-approvals";
import { useHermesClarificationsStore } from "../stores/hermes-clarifications";
import type { BotRuntimeSnapshot } from "@thechat/shared";
let generation = 0;

export async function refreshConversationBackgroundActivity(conversationId: string) {
  const {token,user} = useAuthStore.getState();
  if (!isAuthenticated(token)) return;
  try {
    const {data,error} = await api["bot-runtime"].conversations({conversationId}).get(authHeaders(token));
    if (useAuthStore.getState().token !== token || useAuthStore.getState().user?.id !== user?.id) return;
    if (error || !data || !("invocations" in data)) return;
    useHermesIndicatorsStore.getState().seedFromSnapshot(conversationId,data as BotRuntimeSnapshot,useHermesApprovalsStore.getState().decisions,useHermesClarificationsStore.getState().responses);
  } catch { /* Snapshot safety refetch handles a lost notification. */ }
}

/** Recover sidebar scope from existing authorized read surfaces, never create DMs. */
export async function refreshWorkspaceBackgroundActivity() {
  const epoch = ++generation;
  const { token, user } = useAuthStore.getState();
  const workspace = useWorkspacesStore.getState().activeWorkspace;
  if (!workspace || !isAuthenticated(token)) return;
  const current = () => epoch === generation && useAuthStore.getState().token === token && useAuthStore.getState().user?.id === user?.id && useWorkspacesStore.getState().activeWorkspace?.id === workspace.id;
  try {
    const { data, error } = await api.conversations({ workspaceId: workspace.id }).dms.get(authHeaders(token));
    if (error || !data || !Array.isArray(data) || !current()) return;
    const dms = data.filter(dm => dm.otherBot?.kind === "hermes");
    // A bounded concurrent reader: one batch at a time; no invocation state writes.
    for (let offset = 0; offset < dms.length; offset += 4) {
      await Promise.all(dms.slice(offset, offset + 4).map(async dm => {
        const { data: runtime, error: runtimeError } = await api["bot-runtime"].conversations({ conversationId: dm.id }).get(authHeaders(token));
        if (!current()) return;
        if (runtimeError || !runtime || !("invocations" in runtime)) return;
        useConversationsStore.getState().rememberDirectConversation(dm.otherUser.id, dm.id);
        useHermesIndicatorsStore.getState().seedFromSnapshot(dm.id, runtime as BotRuntimeSnapshot, useHermesApprovalsStore.getState().decisions, useHermesClarificationsStore.getState().responses);
      }));
      if (!current()) return;
    }
  } catch { /* Keep the last safe snapshot on transport failure. */ }
}
