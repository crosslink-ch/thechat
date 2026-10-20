import { useState } from "react";
import type {
  BotRequestAnswer,
  BotRequestPublic,
  BotRequestResponseSpec,
} from "@thechat/shared";
import { Check, CircleSlash, Clock3, ExternalLink, X } from "lucide-react";
import { Avatar } from "./Avatar";
import { Markdown } from "./Markdown";
import { buttonClass, inputClass, type ButtonVariant } from "./ui";
import { BotRequestAnswerError, useBotRequestAnswerer } from "../stores/bot-requests";
import { useAuthStore } from "../stores/auth";

const MAX_UI_COMMAND_CHARS = 100_000;
const MAX_UI_DETAIL_CHARS = 20_000;

/** Neutral request card with a warning-coloured left edge. */
const openCardClass =
  "min-w-0 flex-1 rounded-lg border border-l-3 border-border border-l-warning bg-elevated/60 px-4.5 py-4 text-[0.929rem] text-text-secondary";

/**
 * `stack`: a standalone list such as the Inbox. `timeline`: a row inside a
 * message list, indented like message content so it reads as part of the
 * conversation.
 */
export type BotRequestCardLayout = "stack" | "timeline";

/**
 * One bot request, rendered from its PostgreSQL row. Used inline in threads
 * and channels and in the Inbox, so it never depends on tool activity.
 */
export function BotRequestCard({
  request,
  blocked = false,
  showContext = false,
  onOpenContext,
  layout = "stack",
}: {
  request: BotRequestPublic;
  /** An earlier request in the same order group must be answered first. */
  blocked?: boolean;
  /** Inbox: show where the request was asked and link back to it. */
  showContext?: boolean;
  onOpenContext?: () => void;
  layout?: BotRequestCardLayout;
}) {
  if (request.status !== "open") {
    if (layout === "timeline") {
      return <ResolvedBotRequestTimelineRow request={request} />;
    }
    return (
      <ResolvedBotRequestRow
        request={request}
        showContext={showContext}
        onOpenContext={onOpenContext}
      />
    );
  }
  const card = (
    <OpenBotRequestCard
      request={request}
      blocked={blocked}
      showContext={showContext}
      onOpenContext={onOpenContext}
    />
  );
  if (layout !== "timeline") return card;
  // Avatar-width gutter, so the card lines up with message text.
  return (
    <div data-testid="bot-request-timeline-item" className="flex gap-2.5 px-5 py-1.5">
      <div aria-hidden="true" className="w-8 shrink-0" />
      <div className="min-w-0 flex-1">{card}</div>
    </div>
  );
}

function OpenBotRequestCard({
  request,
  blocked,
  showContext,
  onOpenContext,
}: {
  request: BotRequestPublic;
  blocked: boolean;
  showContext: boolean;
  onOpenContext?: () => void;
}) {
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const answerRequest = useBotRequestAnswerer().answer;
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addressedElsewhere =
    request.audienceUserId !== null && request.audienceUserId !== userId;

  const submit = async (answer: BotRequestAnswer) => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await answerRequest(request.id, answer);
    } catch (cause) {
      // A lost race already merged the winning row; the card re-renders as
      // resolved and shows who answered. Keep the message for other errors.
      if (!(cause instanceof BotRequestAnswerError && cause.request?.status !== "open")) {
        setError(cause instanceof Error ? cause.message : "Could not send the answer");
      }
      setSubmitting(false);
    }
  };

  const command = detailString(request.details, "command", MAX_UI_COMMAND_CHARS);
  const cwd = detailString(request.details, "cwd", 1_000);
  const links = detailLinks(request.details);
  const heading =
    request.kind === "approval"
      ? request.title
      : request.kind === "review"
        ? `${request.botName} asks for a review`
        : `${request.botName} needs your input`;

  return (
    <div className="flex min-w-0">
      <div
        data-testid="bot-request-card"
        data-kind={request.kind}
        data-status={request.status}
        data-request-id={request.id}
        className={`bot-request-card ${openCardClass}`}
      >
        <div className="mb-2 flex min-w-0 items-center gap-2">
          <Avatar
            aria-hidden="true"
            name={request.botName}
            colorKey={request.botUserId}
            bot
            botAvatar={request.botAvatar}
            size={20}
            className="size-5 text-[0.714rem]"
          />
          <div className="min-w-0 flex-1 font-medium text-text">
            {request.kind === "approval" ? `${request.botName}: ${heading}` : heading}
          </div>
          <RequestAge request={request} />
        </div>
        {showContext && (
          <RequestContext request={request} onOpenContext={onOpenContext} />
        )}
        {request.kind !== "approval" && (
          <div className="mt-1 whitespace-pre-wrap break-words font-medium text-text">
            {request.title}
          </div>
        )}
        {command && (
          <code className="my-2.5 block max-h-40 overflow-y-auto whitespace-pre-wrap break-all rounded-md border border-border-subtle bg-raised px-3 py-2 font-mono text-[0.786rem] leading-relaxed text-text">
            {command}
            {cwd && (
              <span className="mt-1 block text-text-dimmed">in {cwd}</span>
            )}
          </code>
        )}
        {request.body && (
          <div className="mb-2.5 break-words text-text-muted">
            <Markdown content={boundText(request.body, MAX_UI_DETAIL_CHARS)} />
          </div>
        )}
        {links.length > 0 && (
          <ul className="mb-3 flex flex-col gap-1">
            {links.map((link) => (
              <li key={link.url}>
                <a
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-accent hover:underline"
                >
                  <ExternalLink size={13} aria-hidden="true" />
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        )}

        {addressedElsewhere ? (
          <div className="text-text-dimmed">
            Waiting for the person this was addressed to.
          </div>
        ) : blocked ? (
          <div className="text-text-dimmed">
            Waiting for the earlier request to be answered first.
          </div>
        ) : (
          <AnswerControls
            request={request}
            spec={request.response}
            submitting={submitting}
            onSubmit={submit}
            onError={setError}
          />
        )}
        {submitting && (
          <div role="status" className="mt-2 text-[0.786rem] text-text-dimmed">
            Sending answer…
          </div>
        )}
        {error && (
          <div role="alert" className="mt-2 text-[0.786rem] text-error-bright">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

function AnswerControls({
  request,
  spec,
  submitting,
  onSubmit,
  onError,
}: {
  request: BotRequestPublic;
  spec: BotRequestResponseSpec;
  submitting: boolean;
  onSubmit: (answer: BotRequestAnswer) => void | Promise<void>;
  onError: (message: string | null) => void;
}) {
  const choices = spec.type === "choice" ? (spec.choices ?? []) : [];
  const freeTextOnly = spec.type === "text";
  const [selected, setSelected] = useState<string[]>([]);
  const [showText, setShowText] = useState(freeTextOnly);
  const [text, setText] = useState("");
  const [comment, setComment] = useState("");
  const maxLength = spec.maxLength ?? 4_000;
  const withComment = (answer: BotRequestAnswer): BotRequestAnswer =>
    spec.allowComment && comment.trim() ? { ...answer, comment: comment.trim() } : answer;

  const submitText = () => {
    const value = text.trim();
    if (!value) {
      onError("Enter a response.");
      return;
    }
    void onSubmit(withComment({ text: value }));
  };

  const textField = (
    <div className="mt-2">
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-end">
        <textarea
          aria-label={freeTextOnly ? "Your response" : "Other response"}
          rows={freeTextOnly ? 2 : 1}
          maxLength={maxLength}
          value={text}
          disabled={submitting}
          onChange={(event) => {
            setText(event.target.value);
            onError(null);
          }}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              submitText();
            }
          }}
          placeholder={freeTextOnly ? "Type your response" : "Type another answer"}
          className={`${inputClass} min-h-9 flex-1 resize-y`}
        />
        <RequestButton
          label="Submit"
          tone="primary"
          disabled={submitting || text.trim().length === 0}
          onClick={submitText}
        />
      </div>
      <div className="mt-1.5 text-[0.714rem] text-text-dimmed">
        Enter to submit · Shift+Enter for a new line
      </div>
    </div>
  );

  return (
    <>
      {spec.allowComment && (
        <textarea
          aria-label="Comment (optional)"
          rows={2}
          maxLength={4_000}
          value={comment}
          disabled={submitting}
          onChange={(event) => setComment(event.target.value)}
          placeholder="Comment (optional)"
          className={`${inputClass} mb-2.5 min-h-9 w-full resize-y`}
        />
      )}
      {choices.length > 0 && !spec.multiple && (
        <div className="flex flex-wrap items-center gap-2">
          {choices.map((choice, index) => (
            <RequestButton
              key={choice}
              label={choiceLabel(request, choice)}
              tone={choiceTone(request, choice, index)}
              wrap={request.kind === "question"}
              disabled={submitting}
              onClick={() => void onSubmit(withComment({ choice }))}
            />
          ))}
          {spec.allowText && (
            <RequestButton
              label={showText ? "Hide other" : "Other"}
              tone="secondary"
              selected={showText}
              disabled={submitting}
              onClick={() => {
                setShowText((visible) => !visible);
                onError(null);
              }}
            />
          )}
        </div>
      )}
      {choices.length > 0 && spec.multiple && (
        <fieldset className="min-w-0" disabled={submitting}>
          <legend className="sr-only">Select one or more answers</legend>
          <div className="flex flex-wrap gap-2">
            {choices.map((choice) => (
              <label
                key={choice}
                className="inline-flex min-h-7 cursor-pointer items-center gap-2 rounded-md border border-border-strong bg-elevated px-2.5 py-1 text-[0.857rem] font-medium text-text transition-colors duration-150 hover:bg-button-hover has-[:checked]:border-accent/60 has-[:checked]:bg-accent/15 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-45"
              >
                <input
                  type="checkbox"
                  checked={selected.includes(choice)}
                  onChange={() => {
                    setSelected((previous) =>
                      previous.includes(choice)
                        ? previous.filter((item) => item !== choice)
                        : [...previous, choice],
                    );
                    onError(null);
                  }}
                  className="size-3.5 accent-accent"
                />
                <span className="break-words">{choiceLabel(request, choice)}</span>
              </label>
            ))}
          </div>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <RequestButton
              label="Submit selected"
              tone="primary"
              disabled={submitting || selected.length === 0}
              onClick={() => void onSubmit(withComment({ choices: selected }))}
            />
            {spec.allowText && (
              <RequestButton
                label={showText ? "Hide custom answer" : "Custom answer"}
                tone="secondary"
                selected={showText}
                disabled={submitting}
                onClick={() => {
                  setShowText((visible) => !visible);
                  onError(null);
                }}
              />
            )}
          </div>
        </fieldset>
      )}
      {showText && textField}
    </>
  );
}

/** Hermes approval choices keep their established button wording. */
const HERMES_APPROVAL_LABELS: Record<string, string> = {
  once: "Allow once",
  session: "Allow for session",
  always: "Always allow",
  deny: "Deny",
};

const PAST_TENSE_LABELS: Record<string, string> = {
  once: "Allowed once",
  session: "Allowed for session",
  always: "Always allowed",
  deny: "Denied",
  approve: "Approved",
  request_changes: "Changes requested",
};

function choiceLabel(request: BotRequestPublic, choice: string) {
  return (
    request.response.labels?.[choice] ??
    (request.kind === "approval" ? HERMES_APPROVAL_LABELS[choice] : undefined) ??
    choice
  );
}

function choiceTone(
  request: BotRequestPublic,
  choice: string,
  index: number,
): ButtonVariant {
  if (request.kind === "question") return "secondary";
  if (choice === "deny" || choice === "request_changes") return "danger-soft";
  return index === 0 ? "primary" : "secondary";
}

function RequestButton({
  label,
  tone,
  wrap = false,
  selected = false,
  disabled = false,
  onClick,
}: {
  label: string;
  tone: ButtonVariant;
  wrap?: boolean;
  selected?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      data-selected={selected ? "true" : undefined}
      className={`${buttonClass(tone, "sm")} data-[selected=true]:border-accent/60 data-[selected=true]:bg-accent/15 ${
        wrap ? "h-auto! min-h-7 whitespace-normal! break-words py-1 text-left" : ""
      }`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/** "Allowed once by Bruno at 14:02", plus delivery state, on one line. */
export function botRequestOutcome(request: BotRequestPublic): {
  text: string;
  tone: "ok" | "denied" | "muted";
} {
  const by = request.answeredBy?.name;
  const at = request.answeredAt ? ` at ${formatClock(request.answeredAt)}` : "";
  if (request.status === "expired") {
    return { text: "Nobody answered in time.", tone: "muted" };
  }
  if (request.status === "cancelled") {
    return {
      text: request.cancelReason?.trim() || `${request.botName} withdrew this request.`,
      tone: "muted",
    };
  }
  const summary = answerSummary(request);
  const denied =
    request.answer?.choice === "deny" || request.answer?.choice === "request_changes";
  const base = `${summary}${by ? ` by ${by}` : ""}${at}`;
  if (request.status === "answered") {
    return {
      text: `${base}, waiting for ${request.botName} to pick it up.`,
      tone: denied ? "denied" : "ok",
    };
  }
  if (request.deliveryApplied === false) {
    return {
      text: `${base}. ${request.botName} could not use it${
        request.deliveryNote ? `: ${request.deliveryNote}` : "."
      }`,
      tone: "muted",
    };
  }
  return { text: `${base}.`, tone: denied ? "denied" : "ok" };
}

function answerSummary(request: BotRequestPublic) {
  const answer = request.answer;
  if (!answer) return "Answered";
  if (answer.choice !== undefined) {
    if (request.kind === "question") {
      return `Answered “${choiceLabel(request, answer.choice)}”`;
    }
    return PAST_TENSE_LABELS[answer.choice] ?? `Answered “${choiceLabel(request, answer.choice)}”`;
  }
  if (answer.choices) {
    return `Answered “${answer.choices
      .map((choice) => choiceLabel(request, choice))
      .join(", ")}”`;
  }
  return `Answered “${boundText(answer.text ?? "", 160)}”`;
}

/**
 * A resolved request in a message list: an icon in the avatar gutter, then
 * the question and its outcome as a quoted pair. It sits where it was
 * resolved, so newer messages follow it.
 */
function ResolvedBotRequestTimelineRow({ request }: { request: BotRequestPublic }) {
  const outcome = botRequestOutcome(request);
  const Icon = resolvedIcon(request, outcome.tone);
  const command = detailString(request.details, "command", 400);
  const asker = request.conversationType === "group" ? `${request.botName} · ` : "";
  const fullAnswer = request.answer?.text;
  return (
    <div
      data-testid="bot-request-resolved"
      data-layout="timeline"
      data-kind={request.kind}
      data-status={request.status}
      data-request-id={request.id}
      className="group/request flex gap-2.5 px-5 py-1 transition-colors duration-100 hover:bg-white/[0.025]"
    >
      <div className="flex w-8 shrink-0 justify-center pt-[0.2em]">
        <Icon size={15} aria-hidden="true" className={resolvedIconClass(outcome.tone)} />
      </div>
      <div className="min-w-0 flex-1 border-l-2 border-border pl-3 text-[0.857rem] leading-snug">
        <div className="break-words text-text-muted">
          {asker && <span className="text-text-dimmed">{asker}</span>}
          <span className="font-medium text-text-secondary">
            {request.kind === "approval" ? request.title : boundText(request.title, 200)}
          </span>
        </div>
        {command && (
          <code
            className="mt-0.5 block truncate font-mono text-[0.714rem] text-text-dimmed"
            title={command}
          >
            {command}
          </code>
        )}
        <div
          data-testid="bot-request-outcome"
          title={fullAnswer && fullAnswer.length > 160 ? fullAnswer : undefined}
          className={`mt-0.5 break-words ${
            outcome.tone === "denied" ? "text-error-light" : "text-text-dimmed"
          }`}
        >
          {outcome.text}
        </div>
      </div>
    </div>
  );
}

function resolvedIcon(
  request: BotRequestPublic,
  tone: ReturnType<typeof botRequestOutcome>["tone"],
) {
  if (request.status === "expired") return Clock3;
  if (request.status === "cancelled") return CircleSlash;
  return tone === "denied" ? X : Check;
}

function resolvedIconClass(tone: ReturnType<typeof botRequestOutcome>["tone"]) {
  if (tone === "denied") return "text-error-bright";
  if (tone === "ok") return "text-text-secondary";
  return "text-text-dimmed";
}

function ResolvedBotRequestRow({
  request,
  showContext,
  onOpenContext,
}: {
  request: BotRequestPublic;
  showContext: boolean;
  onOpenContext?: () => void;
}) {
  const outcome = botRequestOutcome(request);
  const Icon = resolvedIcon(request, outcome.tone);
  const command = detailString(request.details, "command", 400);
  return (
    <div
      data-testid="bot-request-resolved"
      data-kind={request.kind}
      data-status={request.status}
      data-request-id={request.id}
      className="flex min-w-0 flex-col gap-0.5 px-1 py-1 text-[0.929rem]"
    >
      {/* One line when it fits; wraps on narrow columns so who answered stays visible. */}
      <div className="flex min-w-0 items-start gap-2">
        <Icon
          size={15}
          aria-hidden="true"
          className={`mt-[0.2em] shrink-0 ${resolvedIconClass(outcome.tone)}`}
        />
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
          <span className="min-w-0 break-words font-medium text-text-secondary">
            {request.kind === "approval" ? request.title : boundText(request.title, 120)}
          </span>
          <span
            data-testid="bot-request-outcome"
            className={`min-w-0 break-words ${
              outcome.tone === "denied" ? "text-error-light" : "text-text-dimmed"
            }`}
          >
            {outcome.text}
          </span>
        </div>
      </div>
      {command && (
        <code
          className="ml-6 truncate font-mono text-[0.714rem] text-text-dimmed"
          title={command}
        >
          {command}
        </code>
      )}
      {showContext && (
        <div className="ml-6">
          <RequestContext request={request} onOpenContext={onOpenContext} />
        </div>
      )}
    </div>
  );
}

function RequestContext({
  request,
  onOpenContext,
}: {
  request: BotRequestPublic;
  onOpenContext?: () => void;
}) {
  const where =
    request.conversationType === "group"
      ? `#${request.conversationName ?? "channel"}`
      : `DM with ${request.botName}`;
  const label = request.threadTitle ? `${where}, “${request.threadTitle}”` : where;
  return (
    <div className="mb-2 text-[0.786rem] text-text-dimmed">
      {onOpenContext ? (
        <button
          type="button"
          onClick={onOpenContext}
          className="cursor-pointer border-none bg-transparent p-0 font-[inherit] text-text-dimmed underline-offset-2 hover:text-text hover:underline"
        >
          {label}
        </button>
      ) : (
        label
      )}
    </div>
  );
}

function RequestAge({ request }: { request: BotRequestPublic }) {
  return (
    <time
      dateTime={request.createdAt}
      title={new Date(request.createdAt).toLocaleString()}
      className="shrink-0 text-[0.714rem] tabular-nums text-text-dimmed"
    >
      {formatClock(request.createdAt)}
    </time>
  );
}

function formatClock(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function detailString(
  details: Record<string, unknown> | null,
  key: string,
  max: number,
) {
  const value = details?.[key];
  return typeof value === "string" && value.trim() ? boundText(value, max) : "";
}

function detailLinks(details: Record<string, unknown> | null) {
  const raw = details?.links;
  if (!Array.isArray(raw)) return [];
  const links: Array<{ url: string; label: string }> = [];
  for (const item of raw.slice(0, 10)) {
    const url =
      typeof item === "string"
        ? item
        : item && typeof item === "object" && typeof (item as { url?: unknown }).url === "string"
          ? (item as { url: string }).url
          : null;
    if (!url || !/^https?:\/\//i.test(url)) continue;
    const label =
      item && typeof item === "object" && typeof (item as { label?: unknown }).label === "string"
        ? (item as { label: string }).label
        : url;
    links.push({ url, label: boundText(label, 200) });
  }
  return links;
}

function boundText(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}
