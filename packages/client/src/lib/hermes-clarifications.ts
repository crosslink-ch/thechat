import type { BotInvocationProgressEventPublic } from "@thechat/shared";

export type ClarifyResponse = string | string[];

export interface ClarifyRequestState {
  event: BotInvocationProgressEventPublic;
  status: "pending" | "resolved";
  response: ClarifyResponse | null;
  /** True once Hermes confirms the answer with clarify.resolved. */
  confirmed: boolean;
}

export function isClarifyRequestEvent(
  event: BotInvocationProgressEventPublic,
) {
  return event.type === "clarify.request";
}

export function isClarifyResolutionEvent(
  event: BotInvocationProgressEventPublic,
) {
  return event.type === "clarify.resolved";
}

/** Explicit requestId matching is authoritative; older gateways fall back FIFO. */
export function deriveClarifyStates(
  events: BotInvocationProgressEventPublic[],
  localResponses: Record<string, ClarifyResponse>,
): ClarifyRequestState[] {
  const states: ClarifyRequestState[] = [];
  for (const event of [...events].sort(compareBySequence)) {
    if (isClarifyRequestEvent(event)) {
      states.push({
        event,
        status: "pending",
        response: null,
        confirmed: false,
      });
      continue;
    }
    if (!isClarifyResolutionEvent(event)) continue;

    const requestId = stringField(event.payload, "requestId");
    const sessionKey = stringField(event.payload, "sessionKey");
    const candidates = requestId
      ? states.filter(
          (state) =>
            state.status === "pending" &&
            stringField(state.event.payload, "requestId") === requestId,
        )
      : states.filter(
          (state) =>
            state.status === "pending" &&
            (!sessionKey ||
              !stringField(state.event.payload, "sessionKey") ||
              stringField(state.event.payload, "sessionKey") === sessionKey),
        );
    const target = candidates[0];
    if (!target) continue;
    target.status = "resolved";
    target.response = responseField(event.payload);
    target.confirmed = true;
  }

  for (const state of states) {
    if (state.status !== "pending") continue;
    const local = localResponses[state.event.id];
    if (local === undefined) continue;
    state.status = "resolved";
    state.response = local;
  }
  return states;
}

function responseField(
  payload: Record<string, unknown> | null,
): ClarifyResponse | null {
  for (const key of ["response", "answer", "choice", "choices"]) {
    const value = payload?.[key];
    if (typeof value === "string") return value;
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      return value as string[];
    }
  }
  return null;
}

function stringField(source: Record<string, unknown> | null, key: string) {
  const value = source?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function compareBySequence(
  left: BotInvocationProgressEventPublic,
  right: BotInvocationProgressEventPublic,
) {
  if (left.sequence !== right.sequence) return left.sequence - right.sequence;
  return Date.parse(left.createdAt) - Date.parse(right.createdAt);
}
