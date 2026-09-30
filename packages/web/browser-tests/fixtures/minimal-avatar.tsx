import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BotAppearance, BotInvocationPublic, BotInvocationProgressEventPublic, WorkspaceWithDetails } from "@thechat/shared";
import { Avatar } from "@thechat/client/components/Avatar";
import { BotFace } from "@thechat/client/components/BotFace";
import { BotAppearancePicker } from "@thechat/client/components/BotAppearancePicker";
import { HermesProgressInline } from "@thechat/client/components/HermesProgressInline";
import { buttonClass } from "@thechat/client/components/ui";
import { botAppearanceFor } from "@thechat/client/lib/bot-appearance";
import { useConversationDetail, conversationDetailQueryKey } from "@thechat/client/hooks/useConversationDetail";
import { useAuthStore } from "@thechat/client/stores/auth";
import { useWorkspacesStore } from "@thechat/client/stores/workspaces";
import { useHermesApprovalsStore } from "@thechat/client/stores/hermes-approvals";
import { useHermesClarificationsStore } from "@thechat/client/stores/hermes-clarifications";
import "./minimal-avatar.css";

// Real picker, Avatar/BotFace, progress component and workspace store. Only the
// invocation data and accepted callbacks are synthetic; no API or Tauri E2E.
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
  const event: BotInvocationProgressEventPublic = {
    id: "fixture-thinking", invocationId: invocation.id, botId: invocation.botId,
    conversationId: invocation.conversationId, threadId: null, sequence: 1,
    type: "reasoning.delta", status: "running", toolCallId: null, toolName: null,
    label: null, preview: null, payload: { text: "Plan the next step\nCheck the synthetic acceptance evidence." },
    createdAt: date, occurredAt: date,
  };
  if (mode === "running") return [event];
  return [event, {
    ...event, id: `fixture-${mode}`, sequence: 2, status: "waiting",
    type: mode === "approval" ? "approval.request" : "clarify.request",
    payload: mode === "approval"
      ? { command: "pwd", description: "Inspect the synthetic workspace.", choices: ["once", "deny"] }
      : { requestId: "fixture-question", question: "Which approach should we use?", choices: ["Safe", "Fast"], allowOther: true },
  }];
}
function Fixture() {
  const conversation = useConversationDetail("fixture-chat", null);
  const appearance = botAppearanceFor(botUserId, conversation.data?.participants[0].bot?.avatar);
  const [mode, setMode] = useState<Mode>("running");
  const [calls, setCalls] = useState<string[]>([]);
  const changeAppearance = (avatar: BotAppearance) => {
    assistantWorkspace = {
      ...assistantWorkspace,
      members: assistantWorkspace.members.map((member) => ({ ...member, bot: { ...member.bot!, avatar } })),
    };
    useWorkspacesStore.setState({ activeWorkspace: assistantWorkspace });
  };
  const changeMode = (next: Mode) => {
    useHermesApprovalsStore.getState().resetForTests();
    useHermesClarificationsStore.getState().resetForTests();
    setMode(next);
  };
  return <main className="mx-auto grid w-full max-w-3xl gap-5 p-4 text-text">
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
        onInteraction={async (event, response) => { setCalls((old) => [...old, `${event.type}:${JSON.stringify(response)}`]); }}
      />
    </section>
    <output data-testid="callback-log" className="break-all text-sm">{calls.join(" | ")}</output>
    <section aria-label="Motion samples" className="flex flex-wrap gap-4">
      {(["still", "idle", "live", "working", "sleeping"] as const).map((motion) =>
        <div key={motion} data-testid={`motion-${motion}`} className="grid gap-2 text-xs">
          <BotFace appearance={appearance} size={32} motion={motion} />{motion}
        </div>)}
    </section>
  </main>;
}
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={queryClient}><Fixture /></QueryClientProvider>);
