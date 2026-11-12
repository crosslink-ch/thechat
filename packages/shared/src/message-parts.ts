/**
 * Mentions by identity ("parts-v1").
 *
 * A mention is the user ID picked in the @ menu, not the spelling of a name.
 * New clients send an ordered stream of text and reference parts; the server
 * validates every reference against the conversation, stores the parts with a
 * label snapshot, and derives the readable `content` ("Hi @Koda") from them.
 *
 * Legacy `content`-only requests (API, MCP, old clients) keep the name-matching
 * behaviour. A request carries parts or legacy content, never both.
 */

export const PARTS_V1 = "parts-v1" as const;
export const LEGACY_TEXT = "legacy-text" as const;

export type MessageContentFormat = typeof PARTS_V1 | typeof LEGACY_TEXT;

/** What a client sends. */
export type InputChatPart =
  | { type: "text"; text: string }
  | { type: "reference"; refType: "user"; refId: string };

/** What the server stores and returns for a parts-v1 message. */
export type StoredReferencePart = {
  type: "reference";
  refType: "user";
  refId: string;
  /** The target's name when the message was sent, for history and fallbacks. */
  label: string;
  /** Resolved by the server at send time; absent on an optimistic local copy. */
  targetType?: "human" | "bot";
};

export type StoredChatPart = { type: "text"; text: string } | StoredReferencePart;

/** Limits shared by client and server. */
export const MESSAGE_PARTS_LIMITS = {
  /** Total parts in one message. */
  maxParts: 500,
  /** Distinct reference occurrences in one message. */
  maxReferences: 50,
  /** Projected readable content, the same bound as legacy content. */
  maxContentLength: 100_000,
} as const;

/** The readable projection of one reference, e.g. "@Koda". */
export function referenceText(label: string) {
  return `@${label}`;
}

/**
 * Merge adjacent text parts and drop empty ones. References are kept as they
 * are, in order, so every occurrence still renders.
 */
export function normalizeInputParts(parts: readonly InputChatPart[]): InputChatPart[] {
  const result: InputChatPart[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      if (!part.text) continue;
      const last = result[result.length - 1];
      if (last?.type === "text") {
        result[result.length - 1] = { type: "text", text: last.text + part.text };
      } else {
        result.push({ type: "text", text: part.text });
      }
    } else {
      result.push({ type: "reference", refType: part.refType, refId: part.refId });
    }
  }
  return result;
}

/**
 * The readable content of a parts stream: text verbatim, each reference as
 * "@label". Used by the server for `content` and by the client for drafts and
 * optimistic messages, so both sides agree byte for byte.
 */
export function projectPartsContent(
  parts: readonly (InputChatPart | StoredChatPart)[],
  labelFor: (refId: string) => string | undefined = () => undefined,
): string {
  let content = "";
  for (const part of parts) {
    if (part.type === "text") {
      content += part.text;
    } else {
      const label = ("label" in part ? part.label : undefined) ?? labelFor(part.refId) ?? "unknown";
      content += referenceText(label);
    }
  }
  return content;
}

/**
 * Trim leading and trailing whitespace of the whole stream (as legacy content
 * is trimmed), without touching whitespace next to references inside it.
 */
export function trimInputParts(parts: readonly InputChatPart[]): InputChatPart[] {
  const result = normalizeInputParts(parts);
  const first = result[0];
  if (first?.type === "text") {
    const text = first.text.replace(/^\s+/, "");
    if (text) result[0] = { type: "text", text };
    else result.shift();
  }
  const last = result[result.length - 1];
  if (last?.type === "text") {
    const text = last.text.replace(/\s+$/, "");
    if (text) result[result.length - 1] = { type: "text", text };
    else result.pop();
  }
  return result;
}

/** Distinct referenced user IDs, in first-occurrence order. */
export function referencedUserIds(parts: readonly (InputChatPart | StoredChatPart)[] | null | undefined) {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const part of parts ?? []) {
    if (part.type !== "reference" || part.refType !== "user" || seen.has(part.refId)) continue;
    seen.add(part.refId);
    ids.push(part.refId);
  }
  return ids;
}

/** True when the stream contains at least one reference. */
export function hasReferences(parts: readonly (InputChatPart | StoredChatPart)[] | null | undefined) {
  return (parts ?? []).some((part) => part.type === "reference");
}

/**
 * A canonical, comparable form of input parts (normalized, trimmed, only the
 * fields that carry intent). Used for idempotency and retry signatures.
 */
export function inputPartsSignature(parts: readonly InputChatPart[]): string {
  return JSON.stringify(
    trimInputParts(parts).map((part) =>
      part.type === "text" ? ["t", part.text] : ["r", part.refType, part.refId],
    ),
  );
}

/** The input form of stored parts (drops server-resolved fields). */
export function toInputParts(parts: readonly StoredChatPart[]): InputChatPart[] {
  return parts.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : { type: "reference", refType: part.refType, refId: part.refId },
  );
}

/** Narrow unknown JSON (e.g. a stored `messages.parts` column) to stored parts. */
export function isStoredChatParts(value: unknown): value is StoredChatPart[] {
  return (
    Array.isArray(value) &&
    value.every(
      (part) =>
        part &&
        typeof part === "object" &&
        ((part.type === "text" && typeof part.text === "string") ||
          (part.type === "reference" &&
            part.refType === "user" &&
            typeof part.refId === "string" &&
            typeof part.label === "string")),
    )
  );
}
