import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BotAppearance, BotInvocationPublic, BotInvocationProgressEventPublic, BotRequestAnswer, BotRequestPublic, WorkspaceWithDetails } from "@thechat/shared";
import { Avatar } from "@thechat/client/components/Avatar";
import { BotFace } from "@thechat/client/components/BotFace";
import { BotAppearancePicker } from "@thechat/client/components/BotAppearancePicker";
import { HermesProgressInline } from "@thechat/client/components/HermesProgressInline";
import { BotRequestTimelineItems, useBotRequestTimeline } from "@thechat/client/components/BotRequestTimeline";
import { buttonClass } from "@thechat/client/components/ui";
import { botAppearanceFor } from "@thechat/client/lib/bot-appearance";
import { useConversationDetail, conversationDetailQueryKey } from "@thechat/client/hooks/useConversationDetail";
import { useAuthStore } from "@thechat/client/stores/auth";
import { useWorkspacesStore } from "@thechat/client/stores/workspaces";
import { BotRequestAnswererContext, useBotRequestsStore, type BotRequestAnswerer } from "@thechat/client/stores/bot-requests";
import "./minimal-avatar.css";

// Real picker, Avatar/BotFace, progress component, bot request cards and
// workspace/request stores. Only the invocation and request rows and the
// accepted callbacks are synthetic; no API or Tauri E2E.
const date = new Date(Date.now() - 8000).toISOString();
const botUserId = "fixture-bot-user";
const initialMinimal = new URLSearchParams(location.search).get("shape") === "minimal";
const workspace: WorkspaceWithDetails = {
  id: "fixture-workspace", name: "Synthetic workspace", createdAt: date, updatedAt: date,
  channels: [], members: [{
    userId: botUserId, role: "member", joinedAt: date,
    user: { id: botUserId, name: "Assistant", type: "bot", email: null, avatar: null },
    bot: { id: "fixture-bot", kind: "hermes", avatar: { shape: initialMinimal ? "minimal" : "ghost", color: "#00B894" } },
  }],
};
let assistantWorkspace = workspace;
const unrelatedWorkspace: WorkspaceWithDetails = { ...workspace, id: "unrelated-workspace", name: "Unrelated workspace", members: [] };
useWorkspacesStore.setState({ activeWorkspace: new URLSearchParams(location.search).get("workspace") === "unrelated" ? unrelatedWorkspace : workspace });
useAuthStore.setState({ user: { id: "fixture-person", name: "Alex", type: "human", email: null, avatar: null } });
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
queryClient.setQueryData(conversationDetailQueryKey("fixture-chat"), {
  id: "fixture-chat", type: "direct", workspaceId: null, name: null, title: null,
  participants: workspace.members,
});
const invocation: BotInvocationPublic = {
  id: "fixture-run", botId: "fixture-bot", botUserId, botName: "Assistant", botKind: "hermes",
  conversationId: "fixture-chat", threadId: null, triggerMessageId: "fixture-message",
  responseMessageId: null, adapterKind: "hermes", status: "running", externalRunId: null,
  requestJson: null, responseJson: null, error: null, startedAt: date, completedAt: null,
  createdAt: date, updatedAt: date,
};
type Mode = "running" | "queued" | "approval" | "clarification";
function eventsFor(mode: Mode): BotInvocationProgressEventPublic[] {
  if (mode === "queued") return [];
  return [{
    id: "fixture-thinking", invocationId: invocation.id, botId: invocation.botId,
    conversationId: invocation.conversationId, threadId: null, sequence: 1,
    type: "reasoning.delta", status: "running", toolCallId: null, toolName: null,
    label: null, preview: null, payload: { text: "Plan the next step\nCheck the synthetic acceptance evidence." },
    createdAt: date, occurredAt: date,
  }];
}
// Approvals and questions are bot request rows, not progress events: the
// progress row derives "action needed" from an open request for its
// invocation, and the answer card renders from the row in the timeline.
function requestFor(mode: Mode, appearance: BotAppearance): BotRequestPublic | null {
  if (mode !== "approval" && mode !== "clarification") return null;
  const now = new Date().toISOString();
  const approval = mode === "approval";
  return {
    id: `fixture-${mode}`, botId: invocation.botId, botUserId, botName: invocation.botName, botAvatar: appearance,
    conversationId: invocation.conversationId, conversationType: "direct", conversationName: null, workspaceId: null,
    threadId: null, threadTitle: null, invocationId: invocation.id,
    kind: approval ? "approval" : "question",
    title: approval ? "Run a terminal command" : "Which approach should we use?",
    body: approval ? "Inspect the synthetic workspace." : null,
    details: approval ? { command: "pwd" } : null,
    response: approval ? { type: "choice", choices: ["once", "deny"] } : { type: "choice", choices: ["Safe", "Fast"], allowText: true },
    orderGroup: null, audienceUserId: null, status: "open", answer: null, answeredBy: null, answeredAt: null,
    deliveredAt: null, deliveryApplied: null, deliveryNote: null, cancelReason: null, expiresAt: null,
    createdAt: now, updatedAt: now,
  };
}
// Request cards after the progress row, as in HermesDmChatView: requests asked
// after the newest message trail the live activity.
function RequestArea() {
  const timeline = useBotRequestTimeline({ scope: { conversationId: invocation.conversationId, threadId: null }, messages: [] });
  return <section aria-label="Requests" data-testid="request-area" className="min-w-0">
    <BotRequestTimelineItems requests={timeline.trailing} blocked={timeline.blocked} />
  </section>;
}
function Fixture() {
  const conversation = useConversationDetail("fixture-chat", null);
  const appearance = botAppearanceFor(botUserId, conversation.data?.participants[0].bot?.avatar);
  const [mode, setMode] = useState<Mode>("running");
  const [calls, setCalls] = useState<string[]>([]);
  // Local answerer, like /hermes-debug: the card's answer is recorded and the
  // row is stored as answered, exactly as the API's returned row would be.
  const answerer = useMemo<BotRequestAnswerer>(() => ({
    local: true,
    answer: async (requestId: string, answer: BotRequestAnswer) => {
      const request = useBotRequestsStore.getState().byId[requestId];
      setCalls((old) => [...old, `${request.kind}:${JSON.stringify(answer)}`]);
      const now = new Date().toISOString();
      const answered: BotRequestPublic = {
        ...request, status: "answered", answer, answeredBy: { id: "fixture-person", name: "Alex" },
        answeredAt: now, updatedAt: now,
      };
      useBotRequestsStore.getState().upsert(answered);
      return answered;
    },
  }), []);
  const changeAppearance = (avatar: BotAppearance) => {
    assistantWorkspace = {
      ...assistantWorkspace,
      members: assistantWorkspace.members.map((member) => ({ ...member, bot: { ...member.bot!, avatar } })),
    };
    useWorkspacesStore.setState({ activeWorkspace: assistantWorkspace });
  };
  const changeMode = (next: Mode) => {
    useBotRequestsStore.getState().reset();
    const request = requestFor(next, appearance);
    if (request) useBotRequestsStore.getState().upsert(request);
    setMode(next);
  };
  return <BotRequestAnswererContext.Provider value={answerer}><main className="mx-auto grid w-full max-w-3xl gap-5 p-4 text-text">
    <h1 className="text-lg font-semibold">Assistant appearance</h1>
    <div className="flex items-center gap-3">
      <span data-testid="avatar-preview"><Avatar name="Assistant" bot botAvatar={appearance} size={40} className="size-10" /></span>
      <span>Assistant</span>
      <span data-testid="person-avatar"><Avatar name="Alex" size={32} /></span>
    </div>
    <BotAppearancePicker value={appearance} onChange={changeAppearance} />
    <div role="group" aria-label="Sidebar workspace" className="flex flex-wrap gap-2">
      <button type="button" className={buttonClass("secondary", "sm")} onClick={() => useWorkspacesStore.setState({ activeWorkspace: unrelatedWorkspace })}>Switch to unrelated workspace</button>
      <button type="button" className={buttonClass("secondary", "sm")} onClick={() => useWorkspacesStore.setState({ activeWorkspace: assistantWorkspace })}>Return to assistant workspace</button>
    </div>
    <div role="group" aria-label="Fixture activity" className="flex flex-wrap gap-2">
      {(["running", "queued", "approval", "clarification"] as const).map((next) =>
        <button key={next} type="button" className={buttonClass("secondary", "sm")} aria-pressed={mode === next} onClick={() => changeMode(next)}>
          Show {next}
        </button>)}
    </div>
    <section aria-label="Activity" data-testid="progress-area" className="min-w-0 rounded-lg border border-border bg-base">
      <HermesProgressInline
        botAppearances={new Map([[botUserId, appearance]])}
        invocations={[{ invocation: { ...invocation, status: mode === "queued" ? "queued" : "running" }, events: eventsFor(mode) }]}
        onStop={() => setCalls((old) => [...old, "stop"])}
      />
    </section>
    <RequestArea />
    <output data-testid="callback-log" className="break-all text-sm">{calls.join(" | ")}</output>
    <section aria-label="Motion samples" className="flex flex-wrap gap-4">
      {(["still", "idle", "live", "working", "sleeping"] as const).map((motion) =>
        <div key={motion} data-testid={`motion-${motion}`} className="grid gap-2 text-xs">
          <BotFace appearance={appearance} size={32} motion={motion} />{motion}
        </div>)}
    </section>
  </main></BotRequestAnswererContext.Provider>;
}
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={queryClient}><Fixture /></QueryClientProvider>);
