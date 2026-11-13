import { Extension, type AnyExtension, type JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { MarkdownManager } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { Marked, type marked as markedType } from "marked";
import {
  inputPartsSignature,
  normalizeInputParts,
  projectPartsContent,
  type InputChatPart,
  type StoredChatPart,
} from "@thechat/shared";

/**
 * The composer's one serializer: a Tiptap document to a "parts-v1" stream
 * whose text is Markdown, and back.
 *
 * Messages are stored and sent as Markdown. The composer shows that Markdown
 * formatted (lists, quotes, code, headings, bold...), and `@tiptap/markdown`
 * converts each block and mark. A mention picked in the @ menu is a reference
 * part carrying the user's ID: while converting, a mention is a private-use
 * sentinel in the Markdown, so it can sit inside bold or a list item and
 * still comes back as the same reference.
 *
 * Lines: a top-level paragraph is one line and lines are joined with "\n",
 * so plain text is exactly what was typed (as before blocks existed). An
 * empty line is an empty paragraph. Blocks (lists, quotes, code, headings,
 * dividers) are separated from their neighbours by one blank line.
 *
 * Only syntax the composer can show is read as syntax. Links, autolinks,
 * HTML, entities and backslash escapes stay literal text both ways, so what
 * the editor shows is exactly the source that is sent (#87, #91), and typed
 * text is never escaped.
 *
 * Keep every Tiptap-to-message conversion here.
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
const CODE_BLOCK = "codeBlock";
const HEADING = "heading";
const BLOCKQUOTE = "blockquote";
const LIST_ITEM = "listItem";
const BULLET_LIST = "bulletList";
const ORDERED_LIST = "orderedList";
const LINK = "link";

// -- Sentinels ----------------------------------------------------------------

/**
 * A mention inside the Markdown is OPEN, its index, CLOSE. AMP stands in for
 * "&" while parsing, so entity-looking text ("&amp;") is never decoded. All
 * three are private-use code points that are never stored or sent; text that
 * already contains them is neutralized first, so it cannot forge a reference.
 */
const OPEN = "\uE002";
const CLOSE = "\uE003";
const AMP = "\uE004";
const SENTINEL = new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g");
const PRIVATE = /[\uE002-\uE004]/g;
const neutralize = (text: string) => text.replace(PRIVATE, "\uFFFD");

// -- Markdown engine ----------------------------------------------------------

const disabled = () => undefined;

/**
 * Marked, reading only the syntax the composer edits: lists, quotes, fences,
 * ATX headings and rules as blocks; emphasis, strike and code spans as marks.
 * Everything else (links, autolinks, HTML, entities, escapes, hard-break
 * spaces, tables, setext headings, indented code) stays text.
 */
function composerMarked() {
  return new Marked({
    gfm: true,
    breaks: false,
    tokenizer: {
      escape: disabled,
      tag: disabled,
      link: disabled,
      reflink: disabled,
      autolink: disabled,
      url: disabled,
      br: disabled,
      html: disabled,
      def: disabled,
      table: disabled,
      lheading: disabled,
      code: disabled,
    } as never,
  });
}

/** Fence longer than any backtick run that starts a line of the code. */
function codeFence(code: string) {
  const runs = code.match(/^ {0,3}`{3,}/gm) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.trim().length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}

/** How the composer writes a few nodes, overriding the extension defaults. */
const markdownOverrides: AnyExtension[] = [
  // A line break is a line: "\n", like a paragraph split.
  Extension.create({ name: HARD_BREAK, priority: 1000, renderMarkdown: () => "\n" }),
  // Code that contains a fence gets a longer one.
  Extension.create({
    name: CODE_BLOCK,
    priority: 1000,
    renderMarkdown: (node) => {
      const code = (node.content ?? []).map((child) => child.text ?? "").join("");
      const fence = codeFence(code);
      const language = typeof node.attrs?.language === "string" ? node.attrs.language : "";
      return code ? `${fence}${language}\n${code}\n${fence}` : `${fence}${language}\n${fence}`;
    },
  }),
  // An empty heading is still a heading ("#"), so a draft keeps it.
  Extension.create({
    name: HEADING,
    priority: 1000,
    renderMarkdown: (node, helpers) => {
      const level = Number(node.attrs?.level) || 1;
      const marker = "#".repeat(level);
      return node.content?.length ? `${marker} ${helpers.renderChildren(node.content)}` : marker;
    },
  }),
];

let sharedManager: MarkdownManager | null = null;
let sharedMarked: ReturnType<typeof composerMarked> | null = null;

function engine() {
  if (sharedManager && sharedMarked) return { manager: sharedManager, marked: sharedMarked };
  const marked = composerMarked();
  const manager = new MarkdownManager({
    marked: marked as unknown as typeof markedType,
    extensions: [
      StarterKit.configure({
        link: false,
        underline: false,
        trailingNode: false,
        undoRedo: false,
        dropcursor: false,
        gapcursor: false,
      }),
      ...markdownOverrides,
    ],
  });
  // What the editor shows is the source: typed characters are never escaped
  // or entity-encoded. Literal Markdown that was not converted stays literal.
  (manager as unknown as { encodeTextForMarkdown: (text: string) => string })
    .encodeTextForMarkdown = (text) => text;
  sharedManager = manager;
  sharedMarked = marked;
  return { manager, marked };
}

// -- Text nodes -------------------------------------------------------------

const hrefOf = (node: ProseMirrorNode) =>
  node.isText
    ? (node.marks.find((mark) => mark.type.name === LINK)?.attrs.href as string | undefined)
    : undefined;

/**
 * Markdown source for a link, escaped reversibly. URL parsing/re-encoding can
 * corrupt signed query strings, so the destination is escaped, not encoded.
 * Ampersands are escaped too, so entity-looking text stays literal. Returns
 * null when the destination is not a plain http(s) URL.
 */
export function markdownLinkSource(label: string, href: string): string | null {
  if (!label.trim() || !/^https?:\/\//i.test(href) || /[\s\u0000-\u001f\u007f]/.test(href)) return null;
  const escapedLabel = label.replace(/[\\`*_[\]<>!~$&]/g, "\\$&");
  const destination = href.replace(/[\\()<>"']/g, "\\$&")
    .replace(/&(?=#\d+;|#x[\da-f]+;|[a-z][\da-z]+;)/gi, "\\&");
  return `[${escapedLabel}](${destination})`;
}

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
  if (text === href) return text;
  const source = markdownLinkSource(text, href);
  if (!source) return text;
  // Keep a preceding literal ! from turning the generated link into an image.
  const previousText = index > 0 ? parent.child(index - 1).text : precedingText;
  const boundary = previousText?.endsWith("!") ? " " : "";
  return `${boundary}${source}`;
}

// -- Document -> Markdown -------------------------------------------------------

type Reference = { id: string; label: string };

const marksOf = (node: ProseMirrorNode) =>
  node.marks
    .filter((mark) => mark.type.name !== LINK)
    .map((mark) => ({ type: mark.type.name }));

const sameMarks = (left: JSONContent, right: JSONContent) =>
  JSON.stringify(left.marks ?? []) === JSON.stringify(right.marks ?? []);

/** Merge adjacent text with the same marks, so a run renders as one piece. */
function mergeText(content: JSONContent[]): JSONContent[] {
  const merged: JSONContent[] = [];
  for (const child of content) {
    const previous = merged[merged.length - 1];
    if (previous?.type === "text" && child.type === "text" && sameMarks(previous, child)) {
      merged[merged.length - 1] = { ...previous, text: (previous.text ?? "") + (child.text ?? "") };
    } else {
      merged.push(child);
    }
  }
  return merged;
}

const textJSON = (text: string, marks: { type: string }[]): JSONContent =>
  marks.length ? { type: "text", text, marks } : { type: "text", text };

/**
 * Inline content as the Markdown renderer sees it: text (pasted links as
 * their Markdown source), mentions as sentinels with their marks, breaks.
 */
function encodeInline(parent: ProseMirrorNode, references: Reference[]): JSONContent[] {
  const out: JSONContent[] = [];
  parent.forEach((child, _offset, index) => {
    if (child.isText) {
      const text = neutralize(serializeTextNode(child, parent, index));
      if (text) out.push(textJSON(text, marksOf(child)));
    } else if (child.type.name === MENTION) {
      const id = typeof child.attrs.id === "string" && child.attrs.id ? child.attrs.id : null;
      const label = typeof child.attrs.label === "string" ? child.attrs.label : "";
      // A mention node without an ID carries no identity: it is text.
      const text = id
        ? `${OPEN}${references.push({ id, label }) - 1}${CLOSE}`
        : label
          ? neutralize(`@${label}`)
          : "";
      if (text) out.push(textJSON(text, marksOf(child)));
    } else if (child.type.name === HARD_BREAK) {
      out.push({ type: HARD_BREAK });
    }
  });
  return mergeText(out);
}

const isEmptyParagraph = (node: ProseMirrorNode) =>
  node.type.name === PARAGRAPH && node.childCount === 0;

/**
 * Children of a quote or list item. Consecutive lines become one paragraph
 * with "\n" between them; between two such runs the first empty line is
 * the blank line Markdown puts there anyway, further empty lines are kept.
 */
function encodeChildren(parent: ProseMirrorNode, references: Reference[]): JSONContent[] {
  const out: JSONContent[] = [];
  let run: JSONContent[] | null = null;
  let pendingEmpty = 0;
  let afterLines = false;
  const flush = () => {
    for (; pendingEmpty > 0; pendingEmpty--) out.push({ type: PARAGRAPH });
  };
  parent.forEach((child) => {
    if (child.type.name === PARAGRAPH) {
      if (isEmptyParagraph(child)) {
        pendingEmpty += 1;
        run = null;
        return;
      }
      const inline = encodeInline(child, references);
      if (run && pendingEmpty === 0) {
        run.push({ type: "text", text: "\n" }, ...inline);
        return;
      }
      if (pendingEmpty > 0 && afterLines) pendingEmpty -= 1;
      flush();
      run = inline;
      out.push({ type: PARAGRAPH, content: run });
      afterLines = true;
      return;
    }
    flush();
    run = null;
    out.push(encodeBlock(child, references));
    afterLines = false;
  });
  flush();
  // Join the line runs now that they are complete.
  return out.map((block) =>
    block.type === PARAGRAPH && block.content ? { ...block, content: mergeText(block.content) } : block,
  );
}

function encodeBlock(node: ProseMirrorNode, references: Reference[]): JSONContent {
  const name = node.type.name;
  if (name === CODE_BLOCK) {
    const code = neutralize(node.textContent);
    return {
      type: CODE_BLOCK,
      attrs: { language: node.attrs.language ?? null },
      ...(code ? { content: [{ type: "text", text: code }] } : {}),
    };
  }
  if (node.isTextblock) {
    const content = encodeInline(node, references);
    return {
      type: name,
      ...(name === HEADING ? { attrs: { level: node.attrs.level } } : {}),
      ...(content.length ? { content } : {}),
    };
  }
  if (node.isLeaf) return { type: name };
  if (name === BLOCKQUOTE || name === LIST_ITEM) {
    return { type: name, content: encodeChildren(node, references) };
  }
  const content: JSONContent[] = [];
  node.forEach((child) => content.push(encodeBlock(child, references)));
  return {
    type: name,
    ...(name === ORDERED_LIST && node.attrs.start !== 1 ? { attrs: { start: node.attrs.start } } : {}),
    content,
  };
}

/** "- " alone is not a list in Markdown; an empty item is the bare marker. */
const EMPTY_ITEM_MARKER = /^(\s*(?:[-+*]|\d+[.)]))[ \t]+$/gm;

function blockMarkdown(node: ProseMirrorNode, references: Reference[]) {
  const { manager } = engine();
  const json = encodeBlock(node, references);
  const markdown = manager.renderNodes(json, { type: "doc" });
  return json.type === BULLET_LIST || json.type === ORDERED_LIST
    ? markdown.replace(EMPTY_ITEM_MARKER, "$1")
    : markdown;
}

function lineMarkdown(node: ProseMirrorNode, references: Reference[]) {
  const { manager } = engine();
  const content = encodeInline(node, references);
  return content.length ? manager.renderNodes(content, { type: PARAGRAPH, content }) : "";
}

/**
 * The document's Markdown, with sentinels. Top-level paragraphs are lines
 * joined with "\n" (an empty paragraph is an empty line); every other block
 * gets one blank line between it and its neighbours.
 */
function documentMarkdown(doc: ProseMirrorNode): { markdown: string; references: Reference[] } {
  const references: Reference[] = [];
  const entries: string[] = [];
  let afterBlock = false;
  doc.forEach((block) => {
    if (block.type.name === PARAGRAPH) {
      if (afterBlock) entries.push("");
      entries.push(lineMarkdown(block, references));
      afterBlock = false;
      return;
    }
    if (entries.length > 0) entries.push("");
    entries.push(blockMarkdown(block, references));
    afterBlock = true;
  });
  return { markdown: entries.join("\n"), references };
}

function splitSentinels(markdown: string, references: Reference[]) {
  const parts: InputChatPart[] = [];
  const labels: Record<string, string> = {};
  let last = 0;
  for (const match of markdown.matchAll(SENTINEL)) {
    const start = match.index ?? 0;
    if (start > last) parts.push({ type: "text", text: markdown.slice(last, start) });
    const reference = references[Number(match[1])];
    if (reference) {
      parts.push({ type: "reference", refType: "user", refId: reference.id });
      if (reference.label) labels[reference.id] = reference.label;
    }
    last = start + match[0].length;
  }
  if (last < markdown.length) parts.push({ type: "text", text: markdown.slice(last) });
  return { parts: normalizeInputParts(parts), labels };
}

/** Serialize the editor's document to parts, labels and readable text. */
export function serializeComposer(doc: ProseMirrorNode): ComposerDocument {
  const { markdown, references } = documentMarkdown(doc);
  const { parts, labels } = splitSentinels(markdown, references);
  return { parts, labels, text: projectPartsContent(parts, (id) => labels[id]) };
}

// -- Markdown -> document -------------------------------------------------------

const EMPTY_PARAGRAPH: JSONContent = { type: PARAGRAPH };

/** One paragraph per line: split at "\n" inside text and at hard breaks. */
function splitLines(paragraph: JSONContent): JSONContent[] {
  const lines: JSONContent[][] = [[]];
  for (const child of paragraph.content ?? []) {
    if (child.type === HARD_BREAK) {
      lines.push([]);
      continue;
    }
    if (child.type !== "text" || !child.text?.includes("\n")) {
      lines[lines.length - 1]!.push(child);
      continue;
    }
    child.text.split("\n").forEach((piece, index) => {
      if (index > 0) lines.push([]);
      if (piece) lines[lines.length - 1]!.push({ ...child, text: piece });
    });
  }
  return lines.map((content) => (content.length ? { type: PARAGRAPH, content } : { type: PARAGRAPH }));
}

/** Inverse of `encodeChildren`. */
function decodeChildren(children: JSONContent[] | undefined): JSONContent[] {
  const out: JSONContent[] = [];
  let afterLines = false;
  for (const child of children ?? []) {
    if (child.type === PARAGRAPH) {
      if (!child.content?.length) {
        out.push(EMPTY_PARAGRAPH);
        continue;
      }
      if (afterLines) out.push(EMPTY_PARAGRAPH);
      out.push(...splitLines(child));
      afterLines = true;
      continue;
    }
    out.push(decodeBlock(child));
    afterLines = false;
  }
  return out.length ? out : [EMPTY_PARAGRAPH];
}

function decodeBlock(block: JSONContent): JSONContent {
  if (block.type === BLOCKQUOTE || block.type === LIST_ITEM) {
    return { ...block, content: decodeChildren(block.content) };
  }
  if (block.type === BULLET_LIST || block.type === ORDERED_LIST) {
    const items = (block.content ?? []).map(decodeBlock);
    return { ...block, content: items.length ? items : [{ type: LIST_ITEM, content: [EMPTY_PARAGRAPH] }] };
  }
  return block;
}

const countNewlines = (text: string) => (text.match(/\n/g) ?? []).length;

/**
 * Parse Markdown into the editor's blocks. Inverse of `documentMarkdown`:
 * the newlines between two top-level blocks give the empty lines between
 * them (minus the blank line that separates a block from its neighbours).
 */
function markdownBlocks(markdown: string): JSONContent[] {
  const { manager, marked } = engine();
  const source = markdown.replace(/\r\n?/g, "\n");
  const tokens = marked.lexer(source);
  const out: JSONContent[] = [];
  const empties = (count: number) => {
    for (let i = 0; i < count; i++) out.push(EMPTY_PARAGRAPH);
  };

  let position = 0;
  let previousEnd = 0;
  let previousIsBlock: boolean | null = null;
  for (const token of tokens) {
    const start = position;
    position += token.raw.length;
    if (token.type === "space") continue;
    const content = token.raw.replace(/\n+$/, "");
    const isBlock = token.type !== "paragraph" && token.type !== "text";
    const gap = countNewlines(source.slice(previousEnd, start));
    if (previousIsBlock === null) {
      empties(gap - (isBlock && gap > 0 ? 1 : 0));
    } else {
      empties(gap - 1 - (previousIsBlock || isBlock ? 1 : 0));
    }
    for (const block of manager.parse(content).content ?? []) {
      if (block.type === PARAGRAPH) out.push(...splitLines(block));
      else out.push(decodeBlock(block));
    }
    previousEnd = start + content.length;
    previousIsBlock = isBlock;
  }
  const trailing = countNewlines(source.slice(previousEnd));
  if (previousIsBlock === null) empties(trailing);
  else empties(trailing - (previousIsBlock && trailing > 0 ? 1 : 0));
  return out;
}

/** Restore "&" and turn sentinels into mention nodes (or "@label" text). */
function restoreText(
  node: JSONContent,
  mention: (index: number) => JSONContent | null,
  inCode = false,
): JSONContent {
  if (!node.content) return node;
  const code = inCode || node.type === CODE_BLOCK;
  const content: JSONContent[] = [];
  for (const child of node.content) {
    if (child.type !== "text") {
      content.push(restoreText(child, mention, code));
      continue;
    }
    const text = (child.text ?? "").replaceAll(AMP, "&");
    let last = 0;
    const push = (value: string) => {
      if (value) content.push({ ...child, text: value });
    };
    for (const match of text.matchAll(SENTINEL)) {
      const start = match.index ?? 0;
      push(text.slice(last, start));
      const restored = mention(Number(match[1]));
      if (restored?.type === MENTION && !code) {
        content.push(child.marks ? { ...restored, marks: child.marks } : restored);
      } else if (restored) {
        push(restored.type === MENTION ? `@${restored.attrs?.label ?? ""}` : restored.text ?? "");
      }
      last = start + match[0].length;
    }
    push(text.slice(last));
  }
  return { ...node, content: mergeText(content) };
}

/** Markdown with one sentinel per reference; "&" hidden from the parser. */
function partsMarkdown(document: ComposerDocument) {
  const references: string[] = [];
  let markdown = "";
  for (const part of document.parts) {
    markdown += part.type === "reference"
      ? `${OPEN}${references.push(part.refId) - 1}${CLOSE}`
      : neutralize(part.text).replaceAll("&", AMP);
  }
  return { markdown, references };
}

/**
 * The Tiptap document for a composer draft or a message's Markdown: blocks
 * and marks as the composer shows them, and a mention node per reference.
 * The inverse of `serializeComposer` for what the composer emits.
 * `labelFor` supplies a current name; the draft's own label is the fallback.
 */
export function composerToDocument(
  value: MessageInput,
  labelFor: (id: string) => string | undefined = () => undefined,
  { mentions = true }: { mentions?: boolean } = {},
): JSONContent {
  const document = typeof value === "string" ? composerFromText(value) : value;
  const { markdown, references } = partsMarkdown(document);
  const blocks = markdownBlocks(markdown);
  const doc = restoreText({ type: "doc", content: blocks }, (index) => {
    const id = references[index];
    if (!id) return null;
    const label = labelFor(id) ?? document.labels[id] ?? "unknown";
    // An editor without the mention node (no candidates loaded yet) keeps
    // the readable text instead of dropping the whole draft as invalid.
    return mentions
      ? { type: MENTION, attrs: { id, label } }
      : { type: "text", text: `@${label}` };
  });
  return doc.content?.length ? doc : { type: "doc", content: [EMPTY_PARAGRAPH] };
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

/**
 * Whether two composer states are the same edit: identical text, whitespace
 * included, and the same reference IDs in the same places. Drafts and the
 * editor compare this way, so a trailing newline or space is kept.
 */
export function sameComposerDocument(left: ComposerDocument, right: ComposerDocument) {
  const exact = (document: ComposerDocument) =>
    JSON.stringify(
      normalizeInputParts(document.parts).map((part) =>
        part.type === "text" ? ["t", part.text] : ["r", part.refType, part.refId],
      ),
    );
  return exact(left) === exact(right);
}

/**
 * Comparable identity of a send (trimmed, like the server trims it): same text
 * and the same reference IDs. Used for retries, not for comparing edits.
 */
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
