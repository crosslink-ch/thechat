import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { BotInvocationProgressEventPublic, BotInvocationPublic } from "@thechat/shared";
import { HermesDmChatView } from "@thechat/client/components/HermesDmChatView";
import "./chat.css";

// Real shared chat UI and styles, isolated from auth/network with synthetic data.
const params = new URLSearchParams(location.search);
const state = params.get("state") ?? "running";
const now = new Date().toISOString();
const invocation: BotInvocationPublic = {
  id: "progress-fixture", botId: "bot", botUserId: "bot-user", botName: "Koda",
  botKind: "hermes", conversationId: "progress-chat", threadId: null,
  triggerMessageId: "request", responseMessageId: null, adapterKind: "hermes",
  status: state === "queued" ? "queued" : "running", externalRunId: null,
  requestJson: null, responseJson: null, error: null,
  startedAt: state === "queued" ? null : now, completedAt: null,
  createdAt: now, updatedAt: now,
};
const labels = [
  "Read the project brief", "Check existing components", "Review the test setup",
  "Inspect progress styles", "Compare status labels", "Check responsive layout",
  "Write a focused regression test", "Run component tests", "Simplify the status header",
  "Check desktop and mobile layouts", "Capture review screenshots",
];
const events: BotInvocationProgressEventPublic[] = state === "queued" ? [] : labels.map((label, index) => ({
  id: `progress-${index}`, invocationId: invocation.id, botId: "bot",
  conversationId: invocation.conversationId, threadId: null, sequence: index + 1,
  type: "tool.completed", status: "completed", toolCallId: `call-${index}`,
  toolName: "terminal", label, preview: label,
  payload: { args: { command: `printf 'Step ${index + 1} complete'` }, duration: 1.2 },
  occurredAt: now, createdAt: now,
}));
if (state === "approval" || state === "clarify") {
  events.push({
    id: "interaction", invocationId: invocation.id, botId: "bot",
    conversationId: invocation.conversationId, threadId: null, sequence: 12,
    type: state === "approval" ? "approval.request" : "clarify.request",
    status: "waiting", toolCallId: null, toolName: null, label: null, preview: null,
    payload: state === "approval"
      ? { command: "pnpm test", requestId: "approval", sessionKey: "fixture" }
      : { question: "Which layout should I use?", choices: ["Compact", "Detailed"], requestId: "clarify", sessionKey: "fixture", multiSelect: false, allowOther: true },
    occurredAt: now, createdAt: now,
  });
}

function ProgressFixture() {
  const [stopped, setStopped] = useState(false);
  return (
    <div className="flex h-screen min-h-0 flex-col bg-base">
      <HermesDmChatView
        messages={[{
          id: "request", conversationId: invocation.conversationId, threadId: null,
          senderId: "reviewer", senderName: "Alex", senderType: "human",
          content: "Please simplify the progress status and check the layout.", createdAt: now,
        }]}
        loading={false}
        typingUsers={new Map()}
        onSend={() => false}
        scrollKey="progress-fixture"
        progressInvocations={stopped ? [] : [{ invocation, events }]}
        typingSuppressedUserIds={[]}
        onStop={() => setStopped(true)}
        onInteraction={async () => {}}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<ProgressFixture />);
