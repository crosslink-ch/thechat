import type { BotInvocationProgressEventPublic } from "@thechat/shared";
import type { ActiveHermesInvocationProgress } from "./hermes-progress";

export type ApprovalDecision = "once" | "session" | "always" | "deny";

export interface ApprovalRequestState {
  event: BotInvocationProgressEventPublic;
  status: "pending" | "resolved";
  decision: ApprovalDecision | null;
  /** True when Hermes confirmed the resolution with an approval.resolved event. */
  confirmed: boolean;
}

export function isApprovalRequestEvent(event: BotInvocationProgressEventPublic) {
  return event.type === "approval.request";
}

export function isApprovalResolutionEvent(event: BotInvocationProgressEventPublic) {
  return event.type === "approval.resolved";
}

/**
 * Derive the lifecycle state of every approval request in an invocation's
 * event stream.
 *
 * Resolution mirrors the Hermes gateway semantics: `/approve` and `/deny`
 * resolve pending approvals oldest-first (FIFO), so an `approval.resolved`
 * event without an explicit target resolves the oldest request that is still
 * pending. Events with a `sessionKey` payload only resolve requests carrying
 * the same key. Local decisions (the user clicked a button or typed
 * `/approve` in this client) resolve optimistically while we wait for the
 * gateway; they are applied after event-based resolution so a later
 * `approval.resolved` event still targets the same request the local decision
 * did, not the next one in the queue.
 */
export function deriveApprovalStates(
  events: BotInvocationProgressEventPublic[],
  localDecisions: Record<string, ApprovalDecision>,
): ApprovalRequestState[] {
  const sorted = [...events].sort(compareBySequence);
  const states: ApprovalRequestState[] = [];

  for (const event of sorted) {
    if (isApprovalRequestEvent(event)) {
      states.push({ event, status: "pending", decision: null, confirmed: false });
      continue;
    }
    if (!isApprovalResolutionEvent(event)) continue;

    const decision = decisionField(event.payload);
    const sessionKey = stringField(event.payload, "sessionKey");
    const resolveAll = event.payload?.resolveAll === true;
    const candidates = states.filter(
      (state) =>
        state.status === "pending" &&
        (!sessionKey ||
          !stringField(state.event.payload, "sessionKey") ||
          stringField(state.event.payload, "sessionKey") === sessionKey),
    );
    for (const target of resolveAll ? candidates : candidates.slice(0, 1)) {
      target.status = "resolved";
      target.decision = decision;
      target.confirmed = true;
    }
  }

  for (const state of states) {
    if (state.status !== "pending") continue;
    const local = localDecisions[state.event.id];
    if (!local) continue;
    state.status = "resolved";
    state.decision = local;
  }

  return states;
}

/**
 * Pending approval events across the given invocations, oldest first — the
 * order in which the gateway will resolve them.
 */
export function pendingApprovalEvents(
  invocations: ActiveHermesInvocationProgress[],
  localDecisions: Record<string, ApprovalDecision>,
): BotInvocationProgressEventPublic[] {
  return invocations
    .flatMap(({ events }) =>
      deriveApprovalStates(events, localDecisions).filter(
        (state) => state.status === "pending",
      ),
    )
    .map((state) => state.event)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/** Slash command text the gateway expects for a decision. */
export function approvalCommandForDecision(decision: ApprovalDecision) {
  if (decision === "deny") return "/deny";
  if (decision === "session") return "/approve session";
  if (decision === "always") return "/approve always";
  return "/approve";
}

/**
 * Parse a typed `/approve` / `/deny` message into the decision it carries.
 * Mirrors the Hermes gateway's argument handling (`all`, `session`/`ses`,
 * `always`/`permanent`/`permanently`). Returns null for unrelated commands.
 */
export function decisionFromApprovalCommand(
  text: string,
): { decision: ApprovalDecision; all: boolean } | null {
  const match = /^\/(approve|deny)\b(.*)$/i.exec(text.trim());
  if (!match) return null;
  const args = match[2].trim().toLowerCase().split(/\s+/).filter(Boolean);
  const all = args.includes("all");
  if (match[1].toLowerCase() === "deny") return { decision: "deny", all };
  if (args.some((arg) => ["always", "permanent", "permanently"].includes(arg))) {
    return { decision: "always", all };
  }
  if (args.some((arg) => ["session", "ses"].includes(arg))) {
    return { decision: "session", all };
  }
  return { decision: "once", all };
}

export function approvalDecisionLabel(decision: ApprovalDecision) {
  if (decision === "deny") return "Denied";
  if (decision === "session") return "Approved for session";
  if (decision === "always") return "Approved always";
  return "Approved";
}

function decisionField(
  payload: Record<string, unknown> | null,
): ApprovalDecision | null {
  const value = stringField(payload, "choice") || stringField(payload, "decision");
  return value === "once" ||
    value === "session" ||
    value === "always" ||
    value === "deny"
    ? value
    : null;
}

function stringField(source: Record<string, unknown> | null, key: string) {
  const value = source?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function compareBySequence(
  a: BotInvocationProgressEventPublic,
  b: BotInvocationProgressEventPublic,
) {
  if (a.sequence !== b.sequence) return a.sequence - b.sequence;
  return Date.parse(a.createdAt) - Date.parse(b.createdAt);
}
