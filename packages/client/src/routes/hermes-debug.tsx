import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BotInvocationProgressEventPublic,
  BotInvocationPublic,
  BotRequestAnswer,
  BotRequestPublic,
  ChatMessage,
} from "@thechat/shared";
import { HermesDmChatView } from "../components/HermesDmChatView";
import type { ActiveHermesInvocationProgress } from "../lib/hermes-progress";
import {
  BotRequestAnswererContext,
  compareRequests,
  useBotRequestsStore,
  type BotRequestAnswerer,
} from "../stores/bot-requests";
import { HERMES_FALLBACK_SLASH_COMMANDS } from "../lib/hermes-slash-commands";

const CONVERSATION_ID = "hermes-debug-conversation";
const BOT_ID = "hermes-debug-bot";
const BOT_USER_ID = "hermes-debug-hermes";
const BOT_NAME = "Hermes";
const SESSION_KEY = "hermes-debug:general";
const APPROVAL_LABELS: Record<string, string> = {
  once: "Allowed once",
  session: "Allowed for session",
  always: "Always allowed",
  deny: "Denied",
};

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
  const [remountKey, setRemountKey] = useState(0);
  const counterRef = useRef(0);
  const timersRef = useRef<number[]>([]);
  const requestsById = useBotRequestsStore((state) => state.byId);

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
    const command = DEBUG_COMMANDS[counterRef.current % DEBUG_COMMANDS.length]!;
    counterRef.current += 1;
    setPrimary((previous) => ({
      ...previous,
      status: previous.status === "idle" ? "running" : previous.status,
      startedAt: previous.startedAt ?? Date.now(),
    }));
    useBotRequestsStore.getState().upsert(makeApprovalRequest(nextId("request"), command));
  }, [nextId]);

  /** Settle the oldest open request the way the bot would. */
  const settleOldest = useCallback(
    (update: (request: BotRequestPublic) => BotRequestPublic, all = false) => {
      const open = debugOpenRequests(useBotRequestsStore.getState().byId);
      const targets = all ? open : open.slice(0, 1);
      for (const request of targets) useBotRequestsStore.getState().upsert(update(request));
      return targets;
    },
    [],
  );

  const addResolutionEvent = useCallback(() => {
    settleOldest((request) => answeredRow(request, { choice: "once" }, "delivered"));
  }, [settleOldest]);

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
    useBotRequestsStore.getState().reset();
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

  const pendingApprovals = useMemo(() => debugOpenRequests(requestsById), [requestsById]);

  /** What Hermes does once it has an approval decision. */
  const runApproved = useCallback(
    (request: BotRequestPublic, choice: string) => {
      const command = String(request.details?.command ?? "the command");
      schedule(700, () => {
        appendMessage(
          "bot",
          choice === "deny"
            ? "🚫 Denied. I'll skip that command."
            : `✅ ${APPROVAL_LABELS[choice] ?? choice}, running it now.`,
        );
        if (choice === "deny") return;
        emitEvent({
          type: "tool.started",
          status: "running",
          toolCallId: nextId("approved-call"),
          toolName: "terminal",
          label: command,
          payload: { args: { command } },
        });
        schedule(1600, () => completeLastTool());
      });
    },
    [appendMessage, completeLastTool, emitEvent, nextId, schedule],
  );

  // Simulated TheChat + Hermes: the answer lands on the row, the bot picks it
  // up a moment later, exactly like the real answered -> delivered path.
  const answerer = useMemo<BotRequestAnswerer>(
    () => ({
      local: true,
      answer: async (requestId: string, answer: BotRequestAnswer) => {
        const store = useBotRequestsStore.getState();
        const request = store.byId[requestId];
        if (!request || request.status !== "open") {
          throw new Error("This request was already resolved.");
        }
        const answered = answeredRow(request, answer, "answered");
        store.upsert(answered);
        schedule(500, () => {
          useBotRequestsStore.getState().upsert(answeredRow(request, answer, "delivered"));
          runApproved(request, answer.choice ?? "once");
        });
        return answered;
      },
    }),
    [runApproved, schedule],
  );

  // Typed /approve and /deny resolve the waiter in Hermes, which withdraws
  // the matching request.
  const handleSend = useCallback(
    (content: string) => {
      appendMessage("human", content);

      const approval = typedApproval(content);
      if (approval) {
        const settled = settleOldest(
          (request) => ({
            ...request,
            status: "cancelled",
            cancelReason: `${APPROVAL_LABELS[approval.choice]} in chat.`,
            updatedAt: new Date().toISOString(),
          }),
          approval.all,
        );
        if (settled.length === 0) {
          schedule(400, () => appendMessage("bot", "No pending approvals."));
          return true;
        }
        runApproved(settled[0]!, approval.choice);
        return true;
      }

      if (content.trim() === "/stop") {
        completeInvocation();
        return true;
      }

      if (primary.status === "idle") {
        startRunning();
        schedule(500, () => addReasoning());
        schedule(1200, () => addToolStarted());
      }
      return true;
    },
    [
      addReasoning,
      addToolStarted,
      appendMessage,
      completeInvocation,
      completeLastTool,
      primary.status,
      runApproved,
      schedule,
      settleOldest,
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
        <BotRequestAnswererContext.Provider value={answerer}>
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
          requestScope={{ conversationId: CONVERSATION_ID, threadId: null }}
        />
        </BotRequestAnswererContext.Provider>
      </div>

      <aside className="hidden w-[404px] shrink-0 flex-col border-l border-[rgba(245,245,245,0.12)] bg-surface lg:flex">
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <div className="flex items-center justify-between border-b border-[rgba(245,245,245,0.12)] py-1">
            <h2 className="min-w-0 flex-1 text-[1.071rem] font-bold text-white">
              Progress &amp; approvals
            </h2>
            <span className="rounded-md bg-[rgba(245,245,245,0.12)] px-1.5 py-0.5 text-[0.786rem] text-text-secondary">
              {"</>"}dev
            </span>
          </div>

          <div className="mt-5 flex flex-col gap-5">
            <ControlSection title="Scenario">
              <DebugButton icon="play" onClick={scenarioWorking}>Working</DebugButton>
              <DebugButton icon="check" onClick={scenarioApproval}>Approval</DebugButton>
              <DebugButton icon="relation" onClick={scenarioTwoApprovals}>2 approvals</DebugButton>
              <DebugButton icon="refresh" onClick={resetAll}>Reset</DebugButton>
            </ControlSection>

            <ControlSection title="Fire event">
              <DebugButton icon="hand" onClick={addApprovalRequest}>Approval req</DebugButton>
              <DebugButton icon="check" onClick={addResolutionEvent}>Bot resolves</DebugButton>
              <DebugButton icon="tool" onClick={addToolStarted}>Tool started</DebugButton>
              <DebugButton icon="tool" tone="accent" onClick={completeLastTool}>Tool completed</DebugButton>
              <DebugButton icon="info" onClick={() => addNotice("info")}>Notice info</DebugButton>
              <DebugButton icon="warning" onClick={() => addNotice("warn")}>Notice warn</DebugButton>
              <DebugButton icon="alert" onClick={() => addNotice("error")}>Notice error</DebugButton>
              <DebugButton icon="brain" onClick={addReasoning}>Reasoning</DebugButton>
            </ControlSection>

            <ControlSection title="Invocation">
              <DebugButton icon="play" onClick={startRunning}>Start running</DebugButton>
              <DebugButton
                icon="clock"
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
              <DebugButton icon="flag" onClick={completeInvocation}>Complete</DebugButton>
              <DebugButton icon="rotate" onClick={() => setRemountKey((key) => key + 1)}>
                Remount
              </DebugButton>
              <ToggleRow
                checked={secondInvocation}
                label="Second invocation"
                onChange={setSecondInvocation}
              />
              <DebugButton
                className="col-span-2 w-full"
                icon="trash"
                tone="danger"
                onClick={() => useBotRequestsStore.getState().reset()}
              >
                Clear requests
              </DebugButton>
            </ControlSection>

            <ControlSection title="Pending approvals">
              <PendingApprovals approvals={pendingApprovals} />
            </ControlSection>

            <ControlSection title="State">
              <Metric label="Status" value={statusLabel(primary.status)} />
              <Metric label="Events" value={primary.events.length} />
              <Metric label="Open requests" value={pendingApprovals.length} />
              <Metric
                label="Resolved requests"
                value={
                  Object.values(requestsById).filter(
                    (request) =>
                      request.conversationId === CONVERSATION_ID &&
                      request.status !== "open",
                  ).length
                }
              />
            </ControlSection>
          </div>
        </div>
      </aside>
    </div>
  );
}

function debugOpenRequests(byId: Record<string, BotRequestPublic>) {
  return Object.values(byId)
    .filter(
      (request) => request.conversationId === CONVERSATION_ID && request.status === "open",
    )
    .sort(compareRequests);
}

function typedApproval(content: string): { choice: string; all: boolean } | null {
  const [command, ...rest] = content.trim().split(/\s+/);
  const args = rest.map((arg) => arg.toLowerCase());
  const all = args.includes("all");
  if (command === "/deny") return { choice: "deny", all };
  if (command !== "/approve") return null;
  const choice = args.find((arg) => arg === "session" || arg === "always") ?? "once";
  return { choice, all };
}

function makeApprovalRequest(id: string, command: string): BotRequestPublic {
  const nowIso = new Date().toISOString();
  return {
    id,
    botId: BOT_ID,
    botUserId: BOT_USER_ID,
    botName: BOT_NAME,
    conversationId: CONVERSATION_ID,
    conversationType: "direct",
    conversationName: null,
    workspaceId: null,
    threadId: null,
    threadTitle: null,
    invocationId: primaryInvocationId(),
    kind: "approval",
    title: "Run a dangerous command",
    body: "Flagged as a dangerous command.",
    details: { command, cwd: "/srv/app" },
    response: { type: "choice", choices: ["once", "session", "always", "deny"] },
    orderGroup: SESSION_KEY,
    audienceUserId: null,
    status: "open",
    answer: null,
    answeredBy: null,
    answeredAt: null,
    deliveredAt: null,
    deliveryApplied: null,
    deliveryNote: null,
    cancelReason: null,
    expiresAt: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

function answeredRow(
  request: BotRequestPublic,
  answer: BotRequestAnswer,
  status: "answered" | "delivered",
): BotRequestPublic {
  const nowIso = new Date().toISOString();
  return {
    ...request,
    status,
    answer,
    answeredBy: { id: "hermes-debug-user", name: "Bruno" },
    answeredAt: request.answeredAt ?? nowIso,
    deliveredAt: status === "delivered" ? nowIso : null,
    deliveryApplied: status === "delivered" ? true : null,
    updatedAt: nowIso,
  };
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
    <section>
      <div className="mb-1 flex items-center gap-3 py-1">
        <div className="shrink-0 text-[0.786rem] uppercase leading-[16px] text-white">
          {title}
        </div>
        <div className="h-px min-w-0 flex-1 bg-[rgba(245,245,245,0.12)]" />
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {children}
      </div>
    </section>
  );
}

type DebugIconName =
  | "alert"
  | "brain"
  | "check"
  | "clock"
  | "flag"
  | "hand"
  | "info"
  | "play"
  | "refresh"
  | "relation"
  | "rotate"
  | "tool"
  | "trash"
  | "warning";

function DebugIcon({ name }: { name: DebugIconName }) {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: 1.6,
  };

  return (
    <svg className="size-3.5 shrink-0" viewBox="0 0 16 16" aria-hidden="true" {...common}>
      {name === "play" && <path d="M5.25 3.5v9l7-4.5-7-4.5Z" />}
      {name === "check" && (
        <>
          <circle cx="8" cy="8" r="5.25" />
          <path d="m5.6 8.1 1.55 1.55L10.7 6.1" />
        </>
      )}
      {name === "relation" && (
        <>
          <circle cx="4.4" cy="8" r="2" />
          <circle cx="11.6" cy="5" r="2" />
          <circle cx="11.6" cy="11" r="2" />
          <path d="M6.3 7.2 9.7 5.8M6.3 8.8l3.4 1.4" />
        </>
      )}
      {name === "refresh" && (
        <>
          <path d="M13 5.5A5.1 5.1 0 0 0 4.2 3.8L3 5" />
          <path d="M3 2.5V5h2.5" />
          <path d="M3 10.5a5.1 5.1 0 0 0 8.8 1.7L13 11" />
          <path d="M13 13.5V11h-2.5" />
        </>
      )}
      {name === "hand" && (
        <>
          <path d="M5.2 7.7V3.4a1 1 0 0 1 2 0v3.7" />
          <path d="M7.2 7V2.8a1 1 0 0 1 2 0V7" />
          <path d="M9.2 7.3V4a1 1 0 0 1 2 0v5" />
          <path d="M5.2 8.3 4.1 7.2a1.05 1.05 0 0 0-1.5 1.48l3 3.28A4.25 4.25 0 0 0 12.95 9" />
        </>
      )}
      {name === "tool" && (
        <>
          <path d="M10.6 2.6a3 3 0 0 0 2.8 2.8L6.2 12.6a1.8 1.8 0 0 1-2.55-2.55Z" />
          <path d="M4.8 11.2 2.6 13.4" />
        </>
      )}
      {name === "info" && (
        <>
          <circle cx="8" cy="8" r="5.25" />
          <path d="M8 7.5v3.25" />
          <path d="M8 5.25h.01" />
        </>
      )}
      {name === "warning" && (
        <>
          <path d="M8 2.5 14 13H2Z" />
          <path d="M8 6.2v3.1" />
          <path d="M8 11.4h.01" />
        </>
      )}
      {name === "alert" && (
        <>
          <circle cx="8" cy="8" r="5.25" />
          <path d="M8 4.8v4" />
          <path d="M8 11.2h.01" />
        </>
      )}
      {name === "brain" && (
        <>
          <path d="M6.6 3.1a2 2 0 0 0-3 1.7 2.3 2.3 0 0 0 .35 4.55 2.2 2.2 0 0 0 2.65 2.8" />
          <path d="M9.4 3.1a2 2 0 0 1 3 1.7 2.3 2.3 0 0 1-.35 4.55 2.2 2.2 0 0 1-2.65 2.8" />
          <path d="M8 3v10" />
        </>
      )}
      {name === "clock" && (
        <>
          <circle cx="8" cy="8" r="5.25" />
          <path d="M8 5v3.3l2.2 1.3" />
        </>
      )}
      {name === "flag" && (
        <>
          <path d="M4.2 13.5v-11" />
          <path d="M4.2 3h7.2l-1 2 1 2H4.2" />
        </>
      )}
      {name === "rotate" && (
        <>
          <path d="M12.4 6.2a4.5 4.5 0 1 0 1 3.55" />
          <path d="M12.8 3.6v2.8h-2.8" />
        </>
      )}
      {name === "trash" && (
        <>
          <path d="M2.8 4.2h10.4" />
          <path d="M6.4 2.5h3.2" />
          <path d="M4.1 4.2 4.8 13h6.4l.7-8.8" />
          <path d="M6.8 6.7v3.8M9.2 6.7v3.8" />
        </>
      )}
    </svg>
  );
}

function DebugButton({
  children,
  className = "",
  icon,
  onClick,
  tone = "default",
}: {
  children: React.ReactNode;
  className?: string;
  icon?: DebugIconName;
  onClick: () => void;
  tone?: "accent" | "danger" | "default";
}) {
  const toneClass =
    tone === "accent"
      ? "border-[rgba(47,136,191,0.5)] bg-[rgba(47,136,191,0.2)] hover:bg-[rgba(47,136,191,0.28)]"
      : tone === "danger"
        ? "border-[rgba(253,78,72,0.5)] bg-transparent hover:bg-danger-bg"
        : "border-[rgba(245,245,245,0.12)] bg-elevated hover:bg-hover";

  return (
    <button
      type="button"
      className={`flex min-h-9 cursor-pointer items-center justify-center gap-2 rounded border px-3 py-2 text-center text-[0.786rem] font-medium text-text-secondary transition-colors duration-150 hover:text-text ${toneClass} ${className}`}
      onClick={onClick}
    >
      {icon && <DebugIcon name={icon} />}
      {children}
    </button>
  );
}

function ToggleRow({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="col-span-2 flex cursor-pointer items-center gap-2 border-b border-[rgba(245,245,245,0.15)] py-1.5 text-[0.786rem] font-medium leading-4 text-text-secondary">
      <span className="min-w-0 flex-1">{label}</span>
      <input
        className="peer sr-only"
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span className="relative h-3.5 w-7 rounded-full bg-[rgba(245,245,245,0.25)] transition-colors peer-checked:bg-[rgba(245,245,245,0.75)]">
        <span className="absolute left-0.5 top-0.5 size-2.5 rounded-full bg-surface transition-transform peer-checked:translate-x-[14px]" />
      </span>
    </label>
  );
}

function PendingApprovals({
  approvals,
}: {
  approvals: BotRequestPublic[];
}) {
  if (approvals.length === 0) {
    return (
      <div className="col-span-2 flex min-h-[88px] flex-col items-center justify-center rounded border border-[rgba(245,245,245,0.12)] bg-elevated px-5 text-center">
        <DebugIcon name="check" />
        <div className="mt-1 text-[0.786rem] text-text-secondary">No approvals waiting</div>
        <div className="mt-0.5 text-[0.714rem] text-text-dimmed">
          Hermes will pause here if it needs a decision
        </div>
      </div>
    );
  }

  return (
    <div className="col-span-2 flex flex-col gap-1.5">
      {approvals.map((approval) => (
        <div
          key={approval.id}
          className="rounded border border-[rgba(245,245,245,0.12)] bg-elevated px-3 py-2"
        >
          <div className="text-[0.786rem] font-medium text-text-secondary">
            {approval.title}
          </div>
          {typeof approval.details?.command === "string" && (
            <div className="mt-1 truncate font-mono text-[0.714rem] text-text-dimmed">
              {approval.details.command}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="min-h-12 rounded border border-[rgba(245,245,245,0.12)] bg-elevated px-3 py-2">
      <div className="text-[0.714rem] text-text-dimmed">{label}</div>
      <div className="mt-0.5 truncate text-[0.786rem] font-medium text-text-secondary">
        {value}
      </div>
    </div>
  );
}

function statusLabel(status: InvocationStatus) {
  if (status === "idle") return "Idle";
  if (status === "queued") return "Queued";
  return "Running";
}
