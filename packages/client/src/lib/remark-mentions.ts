import { replaceTextNodes, type MdNode } from "./mdast-text";
import { isStoredChatParts, type ChatMessage, type StoredReferencePart } from "@thechat/shared";

/**
 * Mention pills.
 *
 * A "parts-v1" message names its mentions by user ID: its reference parts are
 * the pills, labelled with the person's current name (the label snapshot when
 * they are no longer known), and a typed "@Name" is plain text.
 *
 * A legacy message stores plain "@Display Name" text, so its mentions are
 * still recognised by matching the names of people and bots in the workspace.
 */
export interface MentionNames {
  /** Other members and bots. */
  names: string[];
  /** The signed-in user's name, highlighted differently. */
  self: string | null;
  /** The signed-in user's ID, for mentions by ID. */
  selfId?: string | null;
  /** Current names by user ID, so a renamed person's pill shows the new name. */
  labels?: ReadonlyMap<string, string>;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Longest names first, so "@Razvan Cuceu" wins over a member called "Razvan". */
function mentionPattern(names: string[], flags: string): RegExp | null {
  const unique = [...new Set(names.map((name) => name.trim()).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  if (unique.length === 0) return null;
  // Not after word characters, "." or "@" (emails); not followed by a word character.
  return new RegExp(`(^|[^\\w.@])@(${unique.map(escapeRegExp).join("|")})(?!\\w)`, flags);
}

function pill(text: string, self: boolean, refId?: string): MdNode {
  return {
    type: "mention",
    data: {
      hName: "span",
      hProperties: {
        className: self ? ["md-mention", "md-mention-self"] : ["md-mention"],
        ...(refId ? { "data-mention-id": refId } : {}),
      },
    },
    children: [{ type: "text", value: text }],
  };
}

/** Legacy messages: pills for "@Name" where Name is a known member. */
export function remarkMentions({ names, self }: MentionNames) {
  const pattern = mentionPattern(self ? [...names, self] : names, "gi");
  const selfName = self?.trim().toLowerCase();

  return (tree: MdNode) => {
    if (!pattern) return;
    replaceTextNodes(tree, (value) => {
      const nodes: MdNode[] = [];
      let last = 0;
      for (const match of value.matchAll(pattern)) {
        const start = (match.index ?? 0) + match[1].length;
        const text = `@${match[2]}`;
        if (start > last) nodes.push({ type: "text", value: value.slice(last, start) });
        nodes.push(pill(text, match[2].toLowerCase() === selfName));
        last = start + text.length;
      }
      if (last === 0) return null;
      if (last < value.length) nodes.push({ type: "text", value: value.slice(last) });
      return nodes;
    });
  };
}

// -- parts-v1 -----------------------------------------------------------------

/**
 * Private-use code points mark where each reference sits in the Markdown
 * source of a parts-v1 message, so the whole message is parsed as one
 * document (emphasis or a link around a mention still works) and each marker
 * then becomes a pill. They are never stored or sent.
 */
const OPEN = "\uE000";
const CLOSE = "\uE001";
const SENTINEL = new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g");

export interface PartsMarkdown {
  /** Markdown with one sentinel per reference. */
  source: string;
  /** The references, in sentinel order. */
  references: StoredReferencePart[];
}

/** The renderable form of a parts-v1 message, or null for a legacy message. */
export function partsMarkdown(
  message: Pick<ChatMessage, "contentFormat" | "parts">,
): PartsMarkdown | null {
  if (message.contentFormat !== "parts-v1" || !isStoredChatParts(message.parts)) return null;
  const references: StoredReferencePart[] = [];
  let source = "";
  for (const part of message.parts) {
    if (part.type === "text") {
      // Drop sentinel characters a sender typed, so text cannot forge a pill.
      source += part.text.replace(/[\uE000\uE001]/g, "");
    } else {
      source += `${OPEN}${references.length}${CLOSE}`;
      references.push(part);
    }
  }
  return { source, references };
}

/**
 * Turns the sentinels of a parts-v1 message into pills. Inside code or a
 * link the mention reads as plain "@Name" (it is still the same person).
 */
export function remarkReferenceMentions({
  references,
  names,
}: {
  references: StoredReferencePart[];
  names: MentionNames;
}) {
  const label = (reference: StoredReferencePart) =>
    `@${names.labels?.get(reference.refId) ?? reference.label}`;
  const restore = (value: string) =>
    value.replace(SENTINEL, (_match, index: string) => {
      const reference = references[Number(index)];
      return reference ? label(reference) : "";
    });

  return (tree: MdNode) => {
    replaceTextNodes(tree, (value) => {
      if (!value.includes(OPEN)) return null;
      const nodes: MdNode[] = [];
      let last = 0;
      for (const match of value.matchAll(SENTINEL)) {
        const start = match.index ?? 0;
        const reference = references[Number(match[1])];
        if (start > last) nodes.push({ type: "text", value: value.slice(last, start) });
        if (reference) {
          nodes.push(pill(label(reference), reference.refId === names.selfId, reference.refId));
        }
        last = start + match[0].length;
      }
      if (last < value.length) nodes.push({ type: "text", value: value.slice(last) });
      return nodes;
    });
    // Code, links and other skipped nodes keep the readable "@Name".
    const visit = (node: MdNode) => {
      if (typeof node.value === "string" && node.value.includes(OPEN)) node.value = restore(node.value);
      if (typeof node.url === "string" && node.url.includes(OPEN)) node.url = restore(node.url);
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

// -- "mentions you" -----------------------------------------------------------

/** True when `content` mentions `name`, e.g. to highlight messages mentioning you. */
export function mentionsName(content: string, name: string | null | undefined) {
  if (!name || !content.includes("@")) return false;
  return mentionPattern([name], "i")?.test(content) ?? false;
}

/**
 * Whether a message mentions the signed-in user: by ID for a parts-v1
 * message (a typed "@Name" does not count), by name for a legacy one.
 */
export function messageMentionsUser(
  message: Pick<ChatMessage, "content" | "contentFormat" | "parts">,
  user: { id: string | null | undefined; name: string | null | undefined },
) {
  if (message.contentFormat === "parts-v1") {
    return Boolean(
      user.id &&
        isStoredChatParts(message.parts) &&
        message.parts.some((part) => part.type === "reference" && part.refId === user.id),
    );
  }
  return mentionsName(message.content, user.name);
}
