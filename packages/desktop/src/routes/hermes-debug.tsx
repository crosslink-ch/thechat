import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BotInvocationProgressEventPublic,
  BotInvocationPublic,
  ChatMessage,
} from "@thechat/shared";
import { HermesDmChatView } from "../components/HermesDmChatView";
import type { ActiveHermesInvocationProgress } from "../lib/hermes-progress";
import {
  approvalDecisionLabel,
  decisionFromApprovalCommand,
  pendingApprovalEvents,
} from "../lib/hermes-approvals";
import {
  recordApprovalDecision,
  useHermesApprovalsStore,
} from "../stores/hermes-approvals";
import { HERMES_FALLBACK_SLASH_COMMANDS } from "../lib/hermes-slash-commands";

const CONVERSATION_ID = "hermes-debug-conversation";
const BOT_ID = "hermes-debug-bot";
const BOT_USER_ID = "hermes-debug-hermes";
const BOT_NAME = "Hermes";
const SESSION_KEY = "hermes-debug:general";

const DEBUG_COMMANDS = [
  "rm -rf ~/.cache/old-builds",
  "sudo systemctl restart postgresql",
  "git push --force origin main",
  "curl https://example.com/install.sh | sh",
];

type InvocationStatus = "idle" | "queued" | "running";

interface DebugInvocationState {
  status: InvocationStatus;
  startedAt: number | null;
  events: BotInvocationProgressEventPublic[];
}

const INITIAL_INVOCATION: DebugInvocationState = {
  status: "idle",
  startedAt: null,
  events: [],
};

export function HermesDebugRoute() {
  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    makeMessage("seed-1", "human", "Can you clean up the old build caches on the server?"),
    makeMessage("seed-2", "bot", "Sure — let me check what's there first."),
  ]);
  const [primary, setPrimary] = useState<DebugInvocationState>({
    ...INITIAL_INVOCATION,
  });
  const [secondInvocation, setSecondInvocation] = useState(false);
  const [gatewayEmitsResolution, setGatewayEmitsResolution] = useState(false);
  const [remountKey, setRemountKey] = useState(0);
  const counterRef = useRef(0);
  const timersRef = useRef<number[]>([]);
  const localDecisions = useHermesApprovalsStore((state) => state.decisions);

  useEffect(() => {
    return () => {
      for (const timer of timersRef.current) window.clearTimeout(timer);
    };
  }, []);

  const schedule = useCallback((delayMs: number, run: () => void) => {
    const timer = window.setTimeout(() => {
      timersRef.current = timersRef.current.filter((id) => id !== timer);
      run();
    }, delayMs);
    timersRef.current.push(timer);
  }, []);

  const nextId = useCallback((prefix: string) => {
    counterRef.current += 1;
    return `${prefix}-${counterRef.current}`;
  }, []);

  const appendMessage = useCallback(
    (sender: "human" | "bot", content: string) => {
      setMessages((previous) => [
        ...previous,
        makeMessage(`msg-${previous.length + 1}-${Date.now()}`, sender, content),
      ]);
    },
    [],
  );

  const emitEvent = useCallback(
    (input: Partial<BotInvocationProgressEventPublic>) => {
      setPrimary((previous) => {
        const sequence = previous.events.length + 1;
        const nowIso = new Date().toISOString();
        const event: BotInvocationProgressEventPublic = {
          id: input.id ?? `event-${sequence}-${Date.now()}`,
          invocationId: primaryInvocationId(),
          botId: BOT_ID,
          conversationId: CONVERSATION_ID,
          threadId: null,
          sequence,
          type: input.type ?? "tool.started",
          status: input.status ?? null,
          toolCallId: input.toolCallId ?? null,
          toolName: input.toolName ?? null,
          label: input.label ?? null,
          preview: input.preview ?? null,
          payload: input.payload ?? null,
          occurredAt: nowIso,
          createdAt: nowIso,
        };
        return {
          ...previous,
          status: previous.status === "idle" ? "running" : previous.status,
          startedAt: previous.startedAt ?? Date.now(),
          events: [...previous.events, event],
        };
      });
    },
    [],
  );

  const startRunning = useCallback(() => {
    setPrimary((previous) => ({
      ...previous,
      status: "running",
      startedAt: previous.startedAt ?? Date.now(),
    }));
  }, []);

  const addToolStarted = useCallback(() => {
    const callId = nextId("call");
    const commands = [
      ["read_file", "/srv/app/config/cache.yaml"],
      [
        "terminal",
        "find /var/cache/builds -mindepth 1 -maxdepth 2 -type d -mtime +30 -print0 | xargs -0 du -sh | sort -rh | head -50 && echo '---' && df -h /var/cache && journalctl -u build-cache-gc --since '7 days ago' --no-pager | tail -20",
      ],
      ["grep", "retention.days in /srv/app/config"],
      ["patch", "/srv/app/config/cache.yaml"],
    ];
    const [toolName, label] = commands[counterRef.current % commands.length];
    emitEvent({
      type: "tool.started",
      status: "running",
      toolCallId: callId,
      toolName,
      label,
      payload: { args: {} },
    });
  }, [emitEvent, nextId]);

  const completeLastTool = useCallback(() => {
    setPrimary((previous) => {
      const completed = new Set(
        previous.events
          .filter((event) => event.type === "tool.completed")
          .map((event) => event.toolCallId),
      );
      const running = [...previous.events]
        .reverse()
        .find(
          (event) =>
            event.type === "tool.started" &&
            event.toolCallId &&
            !completed.has(event.toolCallId),
        );
      if (!running) return previous;
      const sequence = previous.events.length + 1;
      const nowIso = new Date().toISOString();
      return {
        ...previous,
        events: [
          ...previous.events,
          {
            ...running,
            id: `event-${sequence}-${Date.now()}`,
            sequence,
            type: "tool.completed",
            status: "completed",
            payload: { duration: 0.4 + (sequence % 5) },
            occurredAt: nowIso,
            createdAt: nowIso,
          },
        ],
      };
    });
  }, []);

  const addApprovalRequest = useCallback(() => {
    const command = DEBUG_COMMANDS[counterRef.current % DEBUG_COMMANDS.length];
    counterRef.current += 1;
    emitEvent({
      type: "approval.request",
      status: "waiting",
      label: "Command approval required",
      preview: command,
      payload: {
        command,
        description: "dangerous command",
        sessionKey: SESSION_KEY,
        choices: ["once", "session", "always", "deny"],
      },
    });
  }, [emitEvent]);

  const addResolutionEvent = useCallback(() => {
    emitEvent({
      type: "approval.resolved",
      status: "completed",
      label: "Approval resolved",
      payload: { choice: "once", sessionKey: SESSION_KEY },
    });
  }, [emitEvent]);

  const addNotice = useCallback(
    (severity: "info" | "warn" | "error") => {
      const byType = {
        info: {
          type: "notice.lifecycle",
          status: "info",
          label: "Session resumed from checkpoint 12 minutes ago",
        },
        warn: {
          type: "notice.warning",
          status: "warning",
          label: "Context is 85% full — compression will run soon",
        },
        error: {
          type: "notice.error",
          status: "failed",
          label: "Compression provider failed — retrying with fallback",
        },
      } as const;
      emitEvent(byType[severity]);
    },
    [emitEvent],
  );

  const addReasoning = useCallback(() => {
    const text = [
      "Checking the cache directory sizes before deciding what is safe to delete.",
      "",
      "The retention policy says 30 days, but the GC service logs show it has not run in a while — I should verify the timer is active before deleting anything manually.",
      "If the GC timer is broken, fixing it is better than a one-off cleanup.",
    ].join("\n");
    emitEvent({
      type: "reasoning.available",
      status: "running",
      preview: text,
      payload: { text },
    });
  }, [emitEvent]);

  const completeInvocation = useCallback(() => {
    setPrimary({ ...INITIAL_INVOCATION });
    appendMessage("bot", "Done — cleaned up 4.2 GB of stale build caches.");
  }, [appendMessage]);

  const resetAll = useCallback(() => {
    for (const timer of timersRef.current) window.clearTimeout(timer);
    timersRef.current = [];
    counterRef.current = 0;
    setPrimary({ ...INITIAL_INVOCATION });
    setSecondInvocation(false);
    setMessages([
      makeMessage("seed-1", "human", "Can you clean up the old build caches on the server?"),
      makeMessage("seed-2", "bot", "Sure — let me check what's there first."),
    ]);
    useHermesApprovalsStore.getState().resetForTests();
  }, []);

  const invocations = useMemo<ActiveHermesInvocationProgress[]>(() => {
    const active: ActiveHermesInvocationProgress[] = [];
    if (primary.status !== "idle") {
      active.push({
        invocation: makeInvocation(primaryInvocationId(), primary),
        events: primary.events,
      });
    }
    if (secondInvocation) {
      active.push(makeSecondInvocation());
    }
    return active;
  }, [primary, secondInvocation]);

  const pendingApprovals = useMemo(
    () => pendingApprovalEvents(invocations, localDecisions),
    [invocations, localDecisions],
  );

  // Simulated Hermes gateway: mirrors how the DM route records optimistic
  // decisions, then answers /approve and /deny like the real gateway does.
  const handleSend = useCallback(
    (content: string) => {
      appendMessage("human", content);

      const approval = decisionFromApprovalCommand(content);
      if (approval) {
        const pending = pendingApprovalEvents(
          invocations,
          useHermesApprovalsStore.getState().decisions,
        );
        if (pending.length === 0) {
          schedule(400, () => appendMessage("bot", "No pending approvals."));
          return;
        }
        const targets = approval.all ? pending : pending.slice(0, 1);
        const command = String(targets[0]?.payload?.command ?? "the command");
        for (const event of targets) {
          recordApprovalDecision(event.id, approval.decision);
        }
        schedule(700, () => {
          appendMessage(
            "bot",
            approval.decision === "deny"
              ? "🚫 Denied. I'll skip that command."
              : `✅ ${approvalDecisionLabel(approval.decision)} — running it now.`,
          );
          if (gatewayEmitsResolution) {
            emitEvent({
              type: "approval.resolved",
              status: "completed",
              payload: {
                choice: approval.decision,
                sessionKey: SESSION_KEY,
                resolveAll: approval.all,
              },
            });
          }
          if (approval.decision !== "deny") {
            const callId = nextId("approved-call");
            emitEvent({
              type: "tool.started",
              status: "running",
              toolCallId: callId,
              toolName: "terminal",
              label: command,
              payload: { args: { command } },
            });
            schedule(1600, () => completeLastTool());
          }
        });
        return;
      }

      if (content.trim() === "/stop") {
        completeInvocation();
        return;
      }

      if (primary.status === "idle") {
        startRunning();
        schedule(500, () => addReasoning());
        schedule(1200, () => addToolStarted());
      }
    },
    [
      addReasoning,
      addToolStarted,
      appendMessage,
      completeInvocation,
      completeLastTool,
      emitEvent,
      gatewayEmitsResolution,
      invocations,
      nextId,
      primary.status,
      schedule,
      startRunning,
    ],
  );

  const scenarioWorking = useCallback(() => {
    resetAll();
    startRunning();
    schedule(50, () => {
      addReasoning();
      addToolStarted();
      completeLastTool();
      addToolStarted();
    });
  }, [addReasoning, addToolStarted, completeLastTool, resetAll, schedule, startRunning]);

  const scenarioApproval = useCallback(() => {
    scenarioWorking();
    schedule(120, () => addApprovalRequest());
  }, [addApprovalRequest, scenarioWorking, schedule]);

  const scenarioTwoApprovals = useCallback(() => {
    scenarioWorking();
    schedule(120, () => {
      addApprovalRequest();
      addApprovalRequest();
    });
  }, [addApprovalRequest, scenarioWorking, schedule]);

  const typingUsers = useMemo(() => new Map<string, string>(), []);

  return (
    <div className="flex min-h-0 flex-1 bg-base">
      <div className="flex min-w-0 flex-1 flex-col">
        <HermesDmChatView
          key={remountKey}
          messages={messages}
          loading={false}
          typingUsers={typingUsers}
          progressInvocations={invocations}
          typingSuppressedUserIds={invocations.length > 0 ? [BOT_USER_ID] : []}
          onSend={handleSend}
          onStop={completeInvocation}
          scrollKey={`hermes-debug:${remountKey}`}
          taskActive={invocations.length > 0}
          slashCommands={HERMES_FALLBACK_SLASH_COMMANDS}
        />
      </div>

      <aside className="hidden w-[360px] shrink-0 flex-col border-l border-border bg-surface/80 lg:flex">
        <div className="border-b border-border px-4 py-3">
          <div className="text-[0.786rem] font-medium uppercase text-text-dimmed">
            Hermes Debug
          </div>
          <div className="text-[1rem] font-semibold text-text">
            Progress &amp; approvals
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <ControlSection title="Scenarios">
            <div className="grid grid-cols-2 gap-1.5">
              <DebugButton onClick={scenarioWorking}>Working</DebugButton>
              <DebugButton onClick={scenarioApproval}>Approval</DebugButton>
              <DebugButton onClick={scenarioTwoApprovals}>2 approvals</DebugButton>
              <DebugButton onClick={resetAll}>Reset</DebugButton>
            </div>
          </ControlSection>

          <ControlSection title="Events">
            <div className="grid grid-cols-2 gap-1.5">
              <DebugButton onClick={addApprovalRequest}>Approval request</DebugButton>
              <DebugButton onClick={addResolutionEvent}>Resolve (event)</DebugButton>
              <DebugButton onClick={addToolStarted}>Tool started</DebugButton>
              <DebugButton onClick={completeLastTool}>Tool completed</DebugButton>
              <DebugButton onClick={() => addNotice("info")}>Notice info</DebugButton>
              <DebugButton onClick={() => addNotice("warn")}>Notice warn</DebugButton>
              <DebugButton onClick={() => addNotice("error")}>Notice error</DebugButton>
              <DebugButton onClick={addReasoning}>Reasoning</DebugButton>
            </div>
          </ControlSection>

          <ControlSection title="Invocation">
            <div className="grid grid-cols-2 gap-1.5">
              <DebugButton onClick={startRunning}>Start running</DebugButton>
              <DebugButton
                onClick={() =>
                  setPrimary((previous) => ({
                    ...previous,
                    status: "queued",
                    startedAt: null,
                    events: [],
                  }))
                }
              >
                Queued
              </DebugButton>
              <DebugButton onClick={completeInvocation}>Complete</DebugButton>
              <DebugButton onClick={() => setRemountKey((key) => key + 1)}>
                Remount view
              </DebugButton>
            </div>
            <label className="mt-1.5 flex cursor-pointer items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2 text-[0.857rem] text-text-secondary">
              <span>Second invocation</span>
              <input
                type="checkbox"
                checked={secondInvocation}
                onChange={(event) => setSecondInvocation(event.currentTarget.checked)}
              />
            </label>
            <label className="mt-1.5 flex cursor-pointer items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2 text-[0.857rem] text-text-secondary">
              <span>Gateway emits approval.resolved</span>
              <input
                type="checkbox"
                checked={gatewayEmitsResolution}
                onChange={(event) =>
                  setGatewayEmitsResolution(event.currentTarget.checked)
                }
              />
            </label>
            <DebugButton
              className="mt-1.5 w-full"
              onClick={() => useHermesApprovalsStore.getState().resetForTests()}
            >
              Clear local decisions
            </DebugButton>
          </ControlSection>

          <ControlSection title="State">
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[0.786rem]">
              <Metric label="Status" value={primary.status} />
              <Metric label="Events" value={primary.events.length} />
              <Metric label="Pending approvals" value={pendingApprovals.length} />
              <Metric
                label="Local decisions"
                value={Object.keys(localDecisions).length}
              />
            </dl>
          </ControlSection>
        </div>
      </aside>
    </div>
  );
}

function primaryInvocationId() {
  return "hermes-debug-invocation-1";
}

function makeInvocation(
  id: string,
  state: DebugInvocationState,
): BotInvocationPublic {
  const startedAtIso = state.startedAt
    ? new Date(state.startedAt).toISOString()
    : null;
  return {
    id,
    botId: BOT_ID,
    botUserId: BOT_USER_ID,
    botName: BOT_NAME,
    botKind: "hermes",
    conversationId: CONVERSATION_ID,
    threadId: null,
    triggerMessageId: "hermes-debug-trigger",
    responseMessageId: null,
    adapterKind: "hermes",
    status: state.status === "queued" ? "queued" : "running",
    externalRunId: null,
    hermesSession: {
      sessionId: "hermes-debug-session",
      sessionKey: SESSION_KEY,
      lineageRootId: "hermes-debug-session",
      reason: "hermes-debug",
      source: "thechat",
      updatedAt: new Date().toISOString(),
    },
    requestJson: null,
    responseJson: null,
    error: null,
    startedAt: startedAtIso,
    completedAt: null,
    createdAt: startedAtIso ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeSecondInvocation(): ActiveHermesInvocationProgress {
  const invocation = makeInvocation("hermes-debug-invocation-2", {
    status: "running",
    startedAt: Date.now() - 95_000,
    events: [],
  });
  const nowIso = new Date().toISOString();
  const events: BotInvocationProgressEventPublic[] = [
    {
      id: "second-tool-1",
      invocationId: invocation.id,
      botId: BOT_ID,
      conversationId: CONVERSATION_ID,
      threadId: null,
      sequence: 1,
      type: "tool.started",
      status: "running",
      toolCallId: "second-call-1",
      toolName: "web_search",
      label: "postgres cache tuning best practices",
      preview: null,
      payload: null,
      occurredAt: nowIso,
      createdAt: nowIso,
    },
  ];
  return { invocation, events };
}

function makeMessage(
  id: string,
  sender: "human" | "bot",
  content: string,
): ChatMessage {
  return {
    id,
    conversationId: CONVERSATION_ID,
    threadId: null,
    senderId: sender === "bot" ? BOT_USER_ID : "hermes-debug-user",
    senderName: sender === "bot" ? BOT_NAME : "Bruno",
    senderType: sender === "bot" ? "bot" : "human",
    content,
    createdAt: new Date().toISOString(),
  };
}

function ControlSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-5">
      <div className="mb-2 text-[0.786rem] font-medium uppercase text-text-dimmed">
        {title}
      </div>
      {children}
    </section>
  );
}

function DebugButton({
  children,
  className = "",
  onClick,
}: {
  children: React.ReactNode;
  className?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`cursor-pointer rounded-md border border-border bg-background px-3 py-2 text-center text-[0.786rem] font-medium text-text-muted transition-colors duration-150 hover:bg-hover hover:text-text ${className}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <>
      <dt className="text-text-dimmed">{label}</dt>
      <dd className="text-right font-mono text-text-secondary">{value}</dd>
    </>
  );
}
