import type { JSONContent } from "@tiptap/react";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  inputPartsSignature,
  normalizeInputParts,
  projectPartsContent,
  type InputChatPart,
  type StoredChatPart,
} from "@thechat/shared";

/**
 * The composer's one serializer: a Tiptap document to a "parts-v1" stream.
 *
 * Text nodes are emitted as the message source (a pasted link becomes
 * Markdown, see `serializeTextNode`). A mention node becomes a user reference
 * by ID. Paragraphs are joined with "\n" and hard breaks are "\n", so the
 * readable projection of the parts is exactly what the plain-text serializer
 * produced before parts existed.
 *
 * Keep every Tiptap-to-message conversion here: block formatting (lists,
 * quotes, code) extends this module rather than adding another serializer.
 */

/** A composer draft: the parts plus their readable text. */
export interface ComposerDocument {
  /** Readable text, as the message's `content` will read. */
  text: string;
  /** Ordered text and references; only references carry identity. */
  parts: InputChatPart[];
  /**
   * Labels of the references by user ID, so a restored draft shows the name
   * that was picked even before the member list loads.
   */
  labels: Record<string, string>;
}

/** What a send accepts: composer output, or plain legacy text. */
export type MessageInput = string | ComposerDocument;

export const EMPTY_COMPOSER_DOCUMENT: ComposerDocument = Object.freeze({
  text: "",
  parts: [],
  labels: {},
}) as ComposerDocument;

const MENTION = "mention";
const HARD_BREAK = "hardBreak";
const PARAGRAPH = "paragraph";

// -- Text nodes -------------------------------------------------------------

const hrefOf = (node: ProseMirrorNode) =>
  node.isText
    ? (node.marks.find((mark) => mark.type.name === "link")?.attrs.href as string | undefined)
    : undefined;

/**
 * The message source of one text node. A pasted anchor becomes a Markdown
 * link; its whole contiguous run (split by other marks) is emitted once.
 */
export function serializeTextNode(
  node: ProseMirrorNode,
  parent: ProseMirrorNode,
  index: number,
  precedingText = "",
): string {
  const href = hrefOf(node);
  if (!href) return node.text ?? "";

  if (index > 0 && hrefOf(parent.child(index - 1)) === href) return "";
  let text = node.text ?? "";
  for (let next = index + 1; next < parent.childCount; next++) {
    const child = parent.child(next);
    if (hrefOf(child) !== href) break;
    text += child.text;
  }
  if (text === href || !text.trim() || !/^https?:\/\//i.test(href) || /[\s\u0000-\u001f\u007f]/.test(href)) return text;
  // Markdown escapes are reversible; URL parsing/re-encoding can corrupt signed
  // query strings. Escape ampersands too, so entity-looking text stays literal.
  const label = text.replace(/[\\`*_[\]<>!~$&]/g, "\\$&");
  const destination = href.replace(/[\\()<>"']/g, "\\$&")
    .replace(/&(?=#\d+;|#x[\da-f]+;|[a-z][\da-z]+;)/gi, "\\&");
  // Keep a preceding literal ! from turning the generated link into an image.
  const previousText = index > 0 ? parent.child(index - 1).text : precedingText;
  const boundary = previousText?.endsWith("!") ? " " : "";
  return `${boundary}[${label}](${destination})`;
}

// -- Document -> parts --------------------------------------------------------

/** Serialize the editor's document to parts, labels and readable text. */
export function serializeComposer(doc: ProseMirrorNode): ComposerDocument {
  const parts: InputChatPart[] = [];
  const labels: Record<string, string> = {};
  const text = (value: string) => {
    if (value) parts.push({ type: "text", text: value });
  };

  const inline = (parent: ProseMirrorNode) => {
    parent.forEach((node, _offset, index) => {
      if (node.isText) {
        text(serializeTextNode(node, parent, index));
      } else if (node.type.name === MENTION) {
        const id = typeof node.attrs.id === "string" && node.attrs.id ? node.attrs.id : null;
        const label = typeof node.attrs.label === "string" ? node.attrs.label : "";
        if (id) {
          parts.push({ type: "reference", refType: "user", refId: id });
          if (label) labels[id] = label;
        } else if (label) {
          // A mention node without an ID carries no identity: it is text.
          text(`@${label}`);
        }
      } else if (node.type.name === HARD_BREAK) {
        text("\n");
      } else if (node.childCount > 0) {
        inline(node);
      }
    });
  };

  doc.forEach((block, _offset, index) => {
    if (index > 0) text("\n");
    if (block.isTextblock) inline(block);
  });

  const normalized = normalizeInputParts(parts);
  return {
    parts: normalized,
    labels,
    text: projectPartsContent(normalized, (id) => labels[id]),
  };
}

// -- Parts -> document --------------------------------------------------------

/**
 * The Tiptap document for a composer draft: one paragraph per line and a
 * mention node per reference. The inverse of `serializeComposer` for what the
 * composer emits. `labelFor` supplies a current name; the draft's own label is
 * the fallback.
 */
export function composerToDocument(
  value: MessageInput,
  labelFor: (id: string) => string | undefined = () => undefined,
): JSONContent {
  const document = typeof value === "string" ? composerFromText(value) : value;
  const paragraphs: JSONContent[][] = [[]];
  const current = () => paragraphs[paragraphs.length - 1]!;
  for (const part of document.parts) {
    if (part.type === "reference") {
      current().push({
        type: MENTION,
        attrs: {
          id: part.refId,
          label: labelFor(part.refId) ?? document.labels[part.refId] ?? "unknown",
        },
      });
      continue;
    }
    part.text.split("\n").forEach((line, index) => {
      if (index > 0) paragraphs.push([]);
      if (line) current().push({ type: "text", text: line });
    });
  }
  return {
    type: "doc",
    content: paragraphs.map((content) =>
      content.length > 0 ? { type: PARAGRAPH, content } : { type: PARAGRAPH },
    ),
  };
}

// -- Helpers ------------------------------------------------------------------

/** A composer document for plain text (e.g. a slash command). */
export function composerFromText(text: string): ComposerDocument {
  return { text, parts: text ? [{ type: "text", text }] : [], labels: {} };
}

/** A composer document from a sent message's stored parts (e.g. to edit it). */
export function composerFromStoredParts(parts: readonly StoredChatPart[]): ComposerDocument {
  const labels: Record<string, string> = {};
  const input: InputChatPart[] = parts.map((part) => {
    if (part.type === "text") return { type: "text", text: part.text };
    labels[part.refId] = part.label;
    return { type: "reference", refType: "user", refId: part.refId };
  });
  const normalized = normalizeInputParts(input);
  return { parts: normalized, labels, text: projectPartsContent(normalized, (id) => labels[id]) };
}

/** The readable text of a send. */
export function messageText(input: MessageInput) {
  return typeof input === "string" ? input : input.text;
}

/** True when the document references at least one user. */
export function composerHasReferences(document: ComposerDocument) {
  return document.parts.some((part) => part.type === "reference");
}

/** Comparable identity of a send: same text and the same reference IDs. */
export function messageInputSignature(input: MessageInput) {
  return typeof input === "string"
    ? JSON.stringify(["legacy", input])
    : JSON.stringify(["parts-v1", inputPartsSignature(input.parts)]);
}

/**
 * The request body for a send. Composer output always goes as "parts-v1",
 * so a typed "@Name" that was not picked from the menu stays plain text.
 * Plain strings (programmatic sends) stay legacy content.
 */
export function messageRequestBody(input: MessageInput):
  | { content: string }
  | { contentFormat: "parts-v1"; parts: InputChatPart[] } {
  return typeof input === "string"
    ? { content: input }
    : { contentFormat: "parts-v1", parts: input.parts };
}

/**
 * Stored-shape parts for an optimistic message, so a pending message shows
 * the same pills as the server's copy will.
 */
export function optimisticParts(
  input: MessageInput,
): { contentFormat?: "parts-v1"; parts: StoredChatPart[] | null } {
  if (typeof input === "string") return { parts: null };
  return {
    contentFormat: "parts-v1",
    parts: input.parts.map((part) =>
      part.type === "text"
        ? part
        : { ...part, label: input.labels[part.refId] ?? "unknown" },
    ),
  };
}
