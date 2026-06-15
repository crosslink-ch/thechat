import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  BotInvocationProgressEventPublic,
  BotInvocationPublic,
  ChatMessage,
} from "@thechat/shared";
import { ChannelChatView } from "../components/ChannelChatView";
import { HermesDmChatView } from "../components/HermesDmChatView";
import type { ActiveHermesInvocationProgress } from "../lib/hermes-progress";

type DebugMode = "hermes" | "channel";
type DebugScopeId = "general" | "task-latex" | "task-code";
type DebugDensity = "mixed" | "latex" | "plain";

interface DebugScope {
  id: DebugScopeId;
  label: string;
  threadId: string | null;
}

const SCOPES: DebugScope[] = [
  { id: "general", label: "General", threadId: null },
  { id: "task-latex", label: "Task: LaTeX", threadId: "debug-task-latex" },
  { id: "task-code", label: "Task: Code", threadId: "debug-task-code" },
];
const INITIAL_VISIBLE_COUNT = 80;
const LOAD_BATCH_SIZE = 20;
const TRIM_VISIBLE_COUNT = 40;
const GENERATED_MESSAGE_COUNT = 260;
const CONVERSATION_ID = "scroll-debug-conversation";
const BOT_ID = "scroll-debug-hermes-bot";
const BOT_USER_ID = "scroll-debug-hermes";

const initialVisibleCounts: Record<DebugScopeId, number> = {
  general: INITIAL_VISIBLE_COUNT,
  "task-latex": INITIAL_VISIBLE_COUNT,
  "task-code": INITIAL_VISIBLE_COUNT,
};

export function ScrollDebugRoute() {
  const [mode, setMode] = useState<DebugMode>("hermes");
  const [activeScopeId, setActiveScopeId] = useState<DebugScopeId>("general");
  const [density, setDensity] = useState<DebugDensity>("latex");
  const [visibleCounts, setVisibleCounts] = useState(initialVisibleCounts);
  const [manualMessagesByScope, setManualMessagesByScope] = useState<
    Record<DebugScopeId, ChatMessage[]>
  >({
    general: [],
    "task-latex": [],
    "task-code": [],
  });
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [showTyping, setShowTyping] = useState(false);
  const [showProgress, setShowProgress] = useState(true);
  const [progressTick, setProgressTick] = useState(4);
  const [parentRerenders, setParentRerenders] = useState(0);
  const [resetVersion, setResetVersion] = useState(0);
  const [metrics, setMetrics] = useState({
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  });

  const activeScope = SCOPES.find((scope) => scope.id === activeScopeId) ?? SCOPES[0];
  const generatedMessages = useMemo(
    () => generateMessages(activeScope, density, mode),
    [activeScope, density, mode],
  );
  const allMessages = useMemo(
    () => [
      ...generatedMessages,
      ...manualMessagesByScope[activeScopeId],
    ],
    [activeScopeId, generatedMessages, manualMessagesByScope],
  );
  const visibleCount = Math.min(visibleCounts[activeScopeId], allMessages.length);
  const messages = useMemo(
    () => allMessages.slice(Math.max(0, allMessages.length - visibleCount)),
    [allMessages, visibleCount],
  );
  const hasOlderMessages = visibleCount < allMessages.length;
  const scrollKey = `scroll-debug:${mode}:${activeScopeId}:${resetVersion}`;
  const typingUsers = useMemo(
    () => (showTyping ? new Map([[BOT_USER_ID, "Hermes"]]) : new Map<string, string>()),
    [showTyping],
  );
  const progressInvocations = useMemo(
    () =>
      mode === "hermes" && showProgress
        ? [buildProgressInvocation(activeScope, progressTick)]
        : [],
    [activeScope, mode, progressTick, showProgress],
  );

  const loadOlderMessages = useCallback(async () => {
    if (loadingOlder) return false;
    setLoadingOlder(true);
    await delay(180);
    // Compute the result here: state updater callbacks run later (during
    // render), so a flag set inside one would still be false on return.
    const current = visibleCounts[activeScopeId];
    const next = Math.min(current + LOAD_BATCH_SIZE, allMessages.length);
    setVisibleCounts((previous) => ({ ...previous, [activeScopeId]: next }));
    setLoadingOlder(false);
    return next > current;
  }, [activeScopeId, allMessages.length, loadingOlder, visibleCounts]);

  const appendMessages = useCallback(
    (count: number, sender: "human" | "bot" = "bot") => {
      const startIndex =
        GENERATED_MESSAGE_COUNT + manualMessagesByScope[activeScopeId].length;
      const nextMessages = Array.from({ length: count }, (_, offset) =>
        makeMessage({
          index: startIndex + offset,
          scope: activeScope,
          density,
          mode,
          sender,
          idPrefix: "manual",
        }),
      );
      setManualMessagesByScope((previous) => ({
        ...previous,
        [activeScopeId]: [...previous[activeScopeId], ...nextMessages],
      }));
      setVisibleCounts((previous) => ({
        ...previous,
        [activeScopeId]: previous[activeScopeId] + count,
      }));
    },
    [activeScope, activeScopeId, density, manualMessagesByScope, mode],
  );

  const handleSend = useCallback(
    (content: string) => {
      const message = makeMessage({
        index: GENERATED_MESSAGE_COUNT + manualMessagesByScope[activeScopeId].length,
        scope: activeScope,
        density,
        mode,
        sender: "human",
        idPrefix: "sent",
        content,
      });
      setManualMessagesByScope((previous) => ({
        ...previous,
        [activeScopeId]: [...previous[activeScopeId], message],
      }));
      setVisibleCounts((previous) => ({
        ...previous,
        [activeScopeId]: previous[activeScopeId] + 1,
      }));
    },
    [activeScope, activeScopeId, density, manualMessagesByScope, mode],
  );

  const setVisibleCount = (count: number) => {
    setVisibleCounts((previous) => ({
      ...previous,
      [activeScopeId]: Math.min(count, allMessages.length),
    }));
  };

  const resetScope = () => {
    setManualMessagesByScope((previous) => ({
      ...previous,
      [activeScopeId]: [],
    }));
    setVisibleCounts((previous) => ({
      ...previous,
      [activeScopeId]: INITIAL_VISIBLE_COUNT,
    }));
    setResetVersion((version) => version + 1);
  };

  useEffect(() => {
    const testId =
      mode === "hermes" ? "hermes-dm-chat-scroll" : "channel-chat-scroll";
    let frame: number | null = null;
    let cleanup: (() => void) | null = null;

    const attach = () => {
      const element = document.querySelector(
        `[data-testid="${testId}"]`,
      ) as HTMLElement | null;
      if (!element) {
        frame = requestAnimationFrame(attach);
        return;
      }

      const update = () => {
        setMetrics({
          scrollTop: Math.round(element.scrollTop),
          scrollHeight: Math.round(element.scrollHeight),
          clientHeight: Math.round(element.clientHeight),
        });
      };

      update();
      element.addEventListener("scroll", update, { passive: true });
      const interval = window.setInterval(update, 250);
      cleanup = () => {
        element.removeEventListener("scroll", update);
        window.clearInterval(interval);
      };
    };

    frame = requestAnimationFrame(attach);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      cleanup?.();
    };
  }, [activeScopeId, messages.length, mode, resetVersion]);

  const distanceFromBottom = Math.max(
    0,
    metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop,
  );

  return (
    <div className="flex min-h-0 flex-1 bg-base">
      <div className="flex min-w-0 flex-1 flex-col">
        {mode === "hermes" ? (
          <HermesDmChatView
            messages={messages}
            loading={false}
            loadingOlder={loadingOlder}
            hasOlderMessages={hasOlderMessages}
            typingUsers={typingUsers}
            progressInvocations={progressInvocations}
            typingSuppressedUserIds={showProgress ? [BOT_USER_ID] : []}
            onSend={handleSend}
            onStop={() => setShowProgress(false)}
            onLoadOlderMessages={loadOlderMessages}
            scrollKey={scrollKey}
            taskActive={showProgress}
            slashCommands={[]}
          />
        ) : (
          <ChannelChatView
            messages={messages}
            loading={false}
            loadingOlder={loadingOlder}
            hasOlderMessages={hasOlderMessages}
            typingUsers={typingUsers}
            onSend={handleSend}
            onLoadOlderMessages={loadOlderMessages}
            scrollKey={scrollKey}
          />
        )}
      </div>

      <aside className="hidden w-[360px] shrink-0 flex-col border-l border-border bg-surface/80 lg:flex">
        <div className="border-b border-border px-4 py-3">
          <div className="text-[0.786rem] font-medium uppercase text-text-dimmed">
            Scroll Debug
          </div>
          <div className="text-[1rem] font-semibold text-text">
            {activeScope.label}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <ControlSection title="View">
            <SegmentedButtons
              value={mode}
              options={[
                { value: "hermes", label: "Hermes DM" },
                { value: "channel", label: "Channel" },
              ]}
              onChange={setMode}
            />
          </ControlSection>

          <ControlSection title="Scope">
            <div className="flex flex-col gap-1.5">
              {SCOPES.map((scope) => (
                <button
                  key={scope.id}
                  type="button"
                  className={rowButtonClass(scope.id === activeScopeId)}
                  onClick={() => setActiveScopeId(scope.id)}
                >
                  <span>{scope.label}</span>
                  <span className="text-[0.714rem] text-text-dimmed">
                    {scope.threadId ?? "unthreaded"}
                  </span>
                </button>
              ))}
            </div>
          </ControlSection>

          <ControlSection title="History">
            <div className="grid grid-cols-2 gap-1.5">
              <DebugButton onClick={() => void loadOlderMessages()}>
                Load older
              </DebugButton>
              <DebugButton onClick={() => setVisibleCount(TRIM_VISIBLE_COUNT)}>
                Trim recent
              </DebugButton>
              <DebugButton onClick={() => appendMessages(1)}>
                Append 1
              </DebugButton>
              <DebugButton onClick={() => appendMessages(10)}>
                Append 10
              </DebugButton>
            </div>
            <div className="mt-1.5 grid grid-cols-4 gap-1.5">
              {[20, 60, 120, 240].map((count) => (
                <DebugButton key={count} onClick={() => setVisibleCount(count)}>
                  {count}
                </DebugButton>
              ))}
            </div>
            <DebugButton className="mt-1.5 w-full" onClick={resetScope}>
              Reset scope
            </DebugButton>
          </ControlSection>

          <ControlSection title="Content">
            <SegmentedButtons
              value={density}
              options={[
                { value: "latex", label: "LaTeX" },
                { value: "mixed", label: "Mixed" },
                { value: "plain", label: "Plain" },
              ]}
              onChange={setDensity}
            />
          </ControlSection>

          <ControlSection title="Signals">
            <label className="flex cursor-pointer items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2 text-[0.857rem] text-text-secondary">
              <span>Typing</span>
              <input
                type="checkbox"
                checked={showTyping}
                onChange={(event) => setShowTyping(event.currentTarget.checked)}
              />
            </label>
            <label className="mt-1.5 flex cursor-pointer items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2 text-[0.857rem] text-text-secondary">
              <span>Hermes progress</span>
              <input
                type="checkbox"
                checked={showProgress}
                onChange={(event) => setShowProgress(event.currentTarget.checked)}
              />
            </label>
            <div className="mt-1.5 grid grid-cols-2 gap-1.5">
              <DebugButton onClick={() => setProgressTick((tick) => tick + 1)}>
                Progress tick
              </DebugButton>
              <DebugButton onClick={() => setParentRerenders((count) => count + 1)}>
                Rerender
              </DebugButton>
            </div>
          </ControlSection>

          <ControlSection title="Metrics">
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[0.786rem]">
              <Metric label="Messages" value={messages.length} />
              <Metric label="All" value={allMessages.length} />
              <Metric label="Older" value={hasOlderMessages ? "yes" : "no"} />
              <Metric label="Rerenders" value={parentRerenders} />
              <Metric label="Scroll top" value={metrics.scrollTop} />
              <Metric label="Height" value={metrics.scrollHeight} />
              <Metric label="Viewport" value={metrics.clientHeight} />
              <Metric label="Bottom gap" value={distanceFromBottom} />
            </dl>
          </ControlSection>
        </div>
      </aside>
    </div>
  );
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

function SegmentedButtons<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex gap-1 rounded-lg bg-raised p-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`flex flex-1 cursor-pointer items-center justify-center rounded-md border-none px-2 py-1.5 text-[0.786rem] font-semibold transition-colors duration-150 ${
            option.value === value
              ? "bg-elevated text-text"
              : "bg-none text-text-muted hover:bg-hover hover:text-text"
          }`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
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

function rowButtonClass(active: boolean) {
  return `flex w-full cursor-pointer items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-[0.857rem] transition-colors duration-150 ${
    active
      ? "border-accent/40 bg-accent/10 text-text"
      : "border-border bg-background text-text-muted hover:bg-hover hover:text-text"
  }`;
}

function generateMessages(
  scope: DebugScope,
  density: DebugDensity,
  mode: DebugMode,
) {
  return Array.from({ length: GENERATED_MESSAGE_COUNT }, (_, index) =>
    makeMessage({ index, scope, density, mode, sender: index % 5 === 0 ? "human" : "bot" }),
  );
}

function makeMessage({
  index,
  scope,
  density,
  mode,
  sender,
  idPrefix = "generated",
  content,
}: {
  index: number;
  scope: DebugScope;
  density: DebugDensity;
  mode: DebugMode;
  sender: "human" | "bot";
  idPrefix?: string;
  content?: string;
}): ChatMessage {
  return {
    id: `${idPrefix}-${mode}-${scope.id}-${index}`,
    conversationId: CONVERSATION_ID,
    threadId: mode === "hermes" ? scope.threadId : null,
    senderId: sender === "bot" ? BOT_USER_ID : "scroll-debug-user",
    senderName: sender === "bot" ? "Hermes" : "Ada",
    senderType: sender === "bot" ? "bot" : "human",
    content: content ?? messageContent(index, density, scope),
    createdAt: new Date(Date.UTC(2026, 0, 1, 9, index)).toISOString(),
  };
}

function messageContent(index: number, density: DebugDensity, scope: DebugScope) {
  if (density === "plain") {
    return `Message ${index + 1} in ${scope.label}. Plain text row with enough length to wrap on narrow widths.`;
  }

  const inlineMath = `$$x_${index} = \\frac{${index + 1}}{${index + 2}}$$`;
  const blockMath = [
    "$$",
    `\\nabla f_${index}(x) = \\sum_{i=1}^{${(index % 7) + 3}} \\alpha_i x_i^2`,
    "$$",
  ].join("\n");

  if (density === "latex") {
    return [
      `LaTeX-heavy message ${index + 1} in ${scope.label}. The inline expression is ${inlineMath}.`,
      blockMath,
      `The follow-up sentence keeps the rendered height uneven so scroll preservation is easier to inspect.`,
    ].join("\n\n");
  }

  if (index % 4 === 0) {
    return [
      `Mixed message ${index + 1} with code and math ${inlineMath}.`,
      "```ts",
      `const value${index} = Math.sqrt(${index + 1});`,
      "```",
    ].join("\n");
  }

  if (index % 3 === 0) {
    return [
      `Mixed message ${index + 1} with a block equation.`,
      blockMath,
    ].join("\n\n");
  }

  return `Mixed message ${index + 1} in ${scope.label}. This one is mostly prose with ${inlineMath}.`;
}

function buildProgressInvocation(
  scope: DebugScope,
  tick: number,
): ActiveHermesInvocationProgress {
  const invocation: BotInvocationPublic = {
    id: `scroll-debug-invocation-${scope.id}`,
    botId: BOT_ID,
    botUserId: BOT_USER_ID,
    botName: "Hermes",
    botKind: "hermes",
    conversationId: CONVERSATION_ID,
    threadId: scope.threadId,
    triggerMessageId: `scroll-debug-trigger-${scope.id}`,
    responseMessageId: null,
    adapterKind: "hermes",
    status: "running",
    externalRunId: null,
    requestJson: { text: "Scroll debug fixture" },
    responseJson: null,
    error: null,
    startedAt: new Date(Date.now() - 20_000).toISOString(),
    completedAt: null,
    createdAt: new Date(Date.now() - 20_000).toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const events = Array.from({ length: Math.max(1, tick) }, (_, index) =>
    progressEvent(scope, index),
  );
  return { invocation, events };
}

function progressEvent(
  scope: DebugScope,
  index: number,
): BotInvocationProgressEventPublic {
  const sequence = index + 1;
  const type = index % 3 === 0 ? "tool.started" : index % 3 === 1 ? "tool.completed" : "reasoning.delta";
  return {
    id: `scroll-debug-progress-${scope.id}-${sequence}`,
    invocationId: `scroll-debug-invocation-${scope.id}`,
    botId: BOT_ID,
    conversationId: CONVERSATION_ID,
    threadId: scope.threadId,
    sequence,
    type,
    status: type === "tool.completed" ? "completed" : "running",
    toolCallId: type.startsWith("tool.") ? `tool-${Math.floor(index / 2)}` : null,
    toolName: type.startsWith("tool.") ? "debug_scroll_fixture" : null,
    label: type.startsWith("tool.")
      ? `Debug update ${sequence}`
      : `Reasoning update ${sequence}`,
    preview: `Visible progress event ${sequence} for ${scope.label}`,
    payload: type === "tool.completed" ? { duration: 120 + index * 9 } : null,
    occurredAt: new Date(Date.now() - (10 - index) * 1000).toISOString(),
    createdAt: new Date(Date.now() - (10 - index) * 1000).toISOString(),
  };
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
