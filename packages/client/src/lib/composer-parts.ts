import { Extension, renderNestedMarkdownContent, type AnyExtension, type JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { MarkdownManager } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { Marked, type marked as markedType } from "marked";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
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
 * The editor document is the authority; Markdown is how it is stored and
 * sent. The contract (docs/composer.md):
 *
 * - Blocks (lists, quotes, code blocks, headings, dividers) and marks (bold,
 *   italic, strike, inline code) are written as Markdown by
 *   `@tiptap/markdown`, with inline content written here.
 * - Literal text is literal: a character that Markdown would read as syntax
 *   at its position is backslash-escaped, so text the composer shows as text
 *   ("- not a list" after undoing the list rule, "2*3") is sent as text and
 *   a restored draft decodes the escapes back.
 * - Markdown source the composer cannot show formatted is kept byte for byte
 *   and rendered after sending: links and images ("[label](url)", which is
 *   what pasted links become, #87 and #91), autolinks, bare URLs and "$$"
 *   math. Escaping them would change link targets, such as signed URLs.
 * - A mark is written only where Markdown can express it. Whitespace and
 *   punctuation at the inside edge of a mark move out of it when the
 *   delimiter could not open or close there ("say **hi**!there"). Each line
 *   with marks is checked against the message renderer's parser and the
 *   draft parser; a mark range they would not read back as written is left
 *   out rather than sent as stray delimiters or HTML.
 * - A mention picked in the @ menu is a reference part carrying the user's
 *   ID. While converting it is a private-use sentinel in the Markdown, so it
 *   can sit inside bold or a list item and still comes back as the same
 *   reference. In inline code it is sent as its readable "@name".
 *
 * Lines: a top-level paragraph is one line and lines are joined with "\n";
 * an empty line is an empty paragraph. Blocks are separated from their
 * neighbours by one blank line.
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
/** An inline node carrying Markdown already written by `lineSource`. */
const INLINE_SOURCE = "composerInlineSource";

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

// -- Kept source ------------------------------------------------------------

/**
 * Spans of literal text that are written byte for byte (see the contract
 * above). The serializer and the draft parser use these same patterns, so a
 * span written raw is read back raw.
 */
const LINK_SOURCE = /!?\[(?:\\[\s\S]|[^\\[\]\n])*\]\((?:\\[\s\S]|[^\\()\s]|\((?:\\[\s\S]|[^\\()\s])*\))*\)/y;
const AUTOLINK_SOURCE =
  /<(?:[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*|[\w.!#$%'*+/=?^`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/y;
const URL_SOURCE = /(?:https?:\/\/|www\.)[^\s<]+/iy;
const MATH_SOURCE = /\$\$(?:[^$\n]|\$(?!\$))+?\$\$/y;
/** An HTML tag or comment: the renderer shows it as text, unprocessed. */
const HTML_SOURCE =
  /<(?:[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^'\n]*'|"[^"\n]*"))?)*\s*\/?|\/[A-Za-z][A-Za-z0-9-]*\s*)>|<!--(?:[^-\n]|-(?!->))*-->/y;
const SOURCE_START = /!\[|\[|<|https?:\/\/|www\.|\$\$/i;
/** Where GFM starts a bare URL: line start, whitespace, `*`, `_`, `~`, `(`. */
const URL_PRECEDES = /^$|[\s*_~(]/;

/** GFM leaves trailing punctuation and an unbalanced ")" out of a bare URL. */
function urlLength(raw: string) {
  let end = raw.length;
  for (;;) {
    const last = raw[end - 1];
    if (last && /[?!.,:*_~'"]/.test(last)) {
      end -= 1;
      continue;
    }
    if (last === ")") {
      const head = raw.slice(0, end);
      if ((head.match(/\)/g) ?? []).length > (head.match(/\(/g) ?? []).length) {
        end -= 1;
        continue;
      }
    }
    return end;
  }
}

/** Length of the kept-source span starting at `index`, or 0. */
function sourceSpanAt(text: string, index: number, previous: string): number {
  const match = (pattern: RegExp) => {
    pattern.lastIndex = index;
    return pattern.exec(text)?.[0].length ?? 0;
  };
  const char = text[index];
  if (char === "[" || (char === "!" && text[index + 1] === "[")) return match(LINK_SOURCE);
  if (char === "<") return match(AUTOLINK_SOURCE) || match(HTML_SOURCE);
  if (char === "$") return match(MATH_SOURCE);
  if (/[hHwW]/.test(char ?? "") && URL_PRECEDES.test(previous)) {
    const length = match(URL_SOURCE);
    return length ? urlLength(text.slice(index, index + length)) : 0;
  }
  return 0;
}

// -- Markdown engine ----------------------------------------------------------

const disabled = () => undefined;

/**
 * Marked, reading only the syntax the composer edits: lists, quotes, fences,
 * ATX headings and rules as blocks; emphasis, strike and code spans as marks;
 * backslash escapes as the literal character. Kept source (links, URLs,
 * math) is read as text, byte for byte. Everything else (HTML, entities,
 * hard-break spaces, tables, setext headings, indented code) stays text.
 */
function composerMarked() {
  return new Marked({
    gfm: true,
    breaks: false,
    tokenizer: {
      // "\&" escapes an entity-looking "&", which is AMP while parsing.
      escape: (src: string) =>
        src.startsWith(`\\${AMP}`) ? { type: "escape", raw: src.slice(0, 2), text: AMP } : false,
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
    extensions: [
      {
        name: "composerSource",
        level: "inline",
        start: (src: string) => {
          const index = src.search(SOURCE_START);
          return index < 0 ? undefined : index;
        },
        tokenizer: (src: string, tokens: { raw: string }[]) => {
          const length = sourceSpanAt(src, 0, tokens.at(-1)?.raw.slice(-1) ?? "");
          if (!length) return undefined;
          const raw = src.slice(0, length);
          return { type: "text", raw, text: raw };
        },
      },
    ],
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
  // Inline content is written by `lineSource`; this node carries the result.
  Extension.create({
    name: INLINE_SOURCE,
    priority: 1000,
    renderMarkdown: (node) => String(node.attrs?.source ?? ""),
  }),
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
  // Every line of an item's text is indented under its marker.
  Extension.create({
    name: LIST_ITEM,
    priority: 1000,
    renderMarkdown: (node, helpers, context) => {
      const prefix = context?.parentType === ORDERED_LIST
        ? `${(Number(context.meta?.parentAttrs?.start) || 1) + (context.index || 0)}. `
        : "- ";
      const output = renderNestedMarkdownContent(node, helpers, prefix, context, {
        alignNestedToPrefix: context?.parentType === ORDERED_LIST,
        indentMainContent: true,
      });
      return output;
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
  sharedManager = manager;
  sharedMarked = marked;
  return { manager, marked };
}

/** The message renderer's parser (Markdown.tsx), to check formatted lines. */
let rendererParser: ReturnType<typeof createRendererParser> | null = null;
function createRendererParser() {
  return unified().use(remarkParse).use(remarkGfm).use(remarkMath, { singleDollarTextMath: false });
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

// -- Inline Markdown ----------------------------------------------------------

type InlineMark = "bold" | "italic" | "strike";
const INLINE_MARKS: InlineMark[] = ["bold", "italic", "strike"];
const DELIMITER: Record<InlineMark, string> = { bold: "**", italic: "*", strike: "~~" };
const CODE = "code";

/** A piece of one line: literal text, kept source, or a mention sentinel. */
interface Piece {
  kind: "text" | "source" | "atom";
  text: string;
  marks: string[];
  /** For a mention: its readable text, used inside inline code. */
  label?: string;
}

/** One unit of a line as it is written: a character, a code span, kept source or a mention. */
interface Unit {
  kind: "char" | "code" | "source" | "atom";
  /** What the message shows. */
  visible: string;
  /** What is written, before mark delimiters. */
  out: string;
  /** The characters a delimiter next to this unit sees. */
  first: string;
  last: string;
  marks: Set<InlineMark>;
}

interface LineContext {
  /** Block syntax (lists, quotes, headings...) could start this line. */
  lineStart: boolean;
  /** Heading text, where trailing "#"s would close the heading. */
  heading: boolean;
}

const ALNUM = /[\p{L}\p{N}]/u;
const WHITESPACE = /\s/u;
const PUNCTUATION = /[\p{P}\p{S}]/u;
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
const ENTITY = /^&(?:#\d{1,7}|#[xX][\da-fA-F]{1,6}|[A-Za-z][A-Za-z\d]{1,31});/;
/** Mention sentinels (private use) behave like letters next to delimiters. */
const edgeChar = (char: string) => (/[\uE002-\uE004]/.test(char) ? "a" : char);

/** Inline code with a fence longer than any backtick run inside it. */
function codeSpan(code: string) {
  const runs = new Set((code.match(/`+/g) ?? []).map((run) => run.length));
  let length = 1;
  while (runs.has(length)) length += 1;
  const fence = "`".repeat(length);
  const pad = code.startsWith("`") || code.endsWith("`")
    || (code.startsWith(" ") && code.endsWith(" ") && /[^ ]/.test(code))
    ? " "
    : "";
  return `${fence}${pad}${code}${pad}${fence}`;
}

/** Offsets of the line's characters that would start block syntax or close a heading. */
function blockSyntaxOffsets(line: string, context: LineContext) {
  const offsets = new Set<number>();
  if (context.lineStart) {
    const indent = line.match(/^[ \t]*/)![0].length;
    const rest = line.slice(indent);
    const ordered = /^(\d{1,9})[.)](?:[ \t]|$)/.exec(rest);
    if (
      /^#{1,6}(?:[ \t]|$)/.test(rest)
      || rest.startsWith(">")
      || /^[-+](?:[ \t]|$)/.test(rest)
      || /^(?:=+|-+)[ \t]*$/.test(rest)
      || /^(?:-[ \t]*){3,}$/.test(rest)
    ) {
      offsets.add(indent);
    } else if (ordered) {
      offsets.add(indent + ordered[1]!.length);
    }
  }
  if (context.heading) {
    const closing = /(^|[ \t])(#+)[ \t]*$/.exec(line);
    if (closing) offsets.add(closing.index + closing[1]!.length);
  }
  return offsets;
}

/** A literal character as Markdown text: escaped where it would be syntax. */
function escapeChar(line: string, offset: number, blockSyntax: Set<number>) {
  const char = line[offset]!;
  const previous = line[offset - 1] ?? "";
  const next = line[offset + 1] ?? "";
  const escaped = `\\${char}`;
  switch (char) {
    case "\\":
      return next === "" || ASCII_PUNCTUATION.test(next) ? "\\\\" : char;
    case "*":
    case "`":
    case "~":
    case "[":
      return escaped;
    case "_":
      return ALNUM.test(previous) && ALNUM.test(next) ? char : escaped;
    case "&":
      return ENTITY.test(line.slice(offset)) ? escaped : char;
    case "<":
      return /[A-Za-z/!?]/.test(next) ? escaped : char;
    case "$":
      return previous === "$" || next === "$" ? escaped : char;
    default:
      return blockSyntax.has(offset) ? escaped : char;
  }
}

/** The line's units: kept source found in literal text, code spans grouped, text escaped. */
function lineUnits(pieces: Piece[], context: LineContext): Unit[] {
  // Characters with their kind and marks, kept source located.
  type Char = { char: string; kind: Piece["kind"]; marks: string[]; label?: string };
  const chars: Char[] = [];
  for (const piece of pieces) {
    if (piece.kind === "atom") {
      chars.push({ char: piece.text, kind: "atom", marks: piece.marks, label: piece.label });
    } else {
      for (const char of piece.text) chars.push({ char, kind: piece.kind, marks: piece.marks });
    }
  }
  // Leading whitespace of four columns or more would be indented code, which
  // a message line never is; it is never shown either, so three spaces stay.
  let indent = 0;
  while (chars[indent]?.kind === "text" && /[ \t]/.test(chars[indent]!.char)) indent += 1;
  const columns = chars.slice(0, indent).reduce((sum, char) => sum + (char.char === "\t" ? 4 : 1), 0);
  if (context.lineStart && columns >= 4) {
    chars.splice(0, indent, ...Array.from({ length: 3 }, () => ({ ...chars[0]!, char: " " })));
  }

  const plain = chars.map((char) => (char.kind === "atom" ? "\uFFFC" : char.char)).join("");
  // Offsets in `plain` are code units; map each char to its offset.
  const offsets: number[] = [];
  chars.reduce((offset, char, index) => {
    offsets[index] = offset;
    return offset + (char.kind === "atom" ? 1 : char.char.length);
  }, 0);
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index]!;
    if (char.kind !== "text" || char.marks.includes(CODE)) continue;
    const length = sourceSpanAt(plain, offsets[index]!, plain[offsets[index]! - 1] ?? "");
    if (!length) continue;
    const end = offsets[index]! + length;
    let last = index;
    while (last + 1 < chars.length && offsets[last + 1]! < end) last += 1;
    const span = chars.slice(index, last + 1);
    if (span.some((part) => part.kind === "atom" || part.marks.includes(CODE))) continue;
    for (const part of span) part.kind = "source";
    index = last;
  }

  const inlineMarks = (marks: string[]) =>
    new Set(INLINE_MARKS.filter((mark) => marks.includes(mark)));
  const units: Unit[] = [];
  for (let index = 0; index < chars.length; ) {
    const char = chars[index]!;
    if (char.marks.includes(CODE)) {
      let code = "";
      let marks = inlineMarks(char.marks);
      for (; index < chars.length && chars[index]!.marks.includes(CODE); index++) {
        const part = chars[index]!;
        code += part.kind === "atom" ? part.label ?? "" : part.char;
        const own = inlineMarks(part.marks);
        marks = new Set([...marks].filter((mark) => own.has(mark)));
      }
      if (code) units.push({ kind: "code", visible: code, out: codeSpan(code), first: "`", last: "`", marks });
      continue;
    }
    if (char.kind === "source") {
      let raw = "";
      const key = char.marks.join(",");
      for (; index < chars.length && chars[index]!.kind === "source" && chars[index]!.marks.join(",") === key && !chars[index]!.marks.includes(CODE); index++) {
        raw += chars[index]!.char;
      }
      units.push({ kind: "source", visible: raw, out: raw, first: raw[0]!, last: raw.at(-1)!, marks: inlineMarks(char.marks) });
      continue;
    }
    if (char.kind === "atom") {
      units.push({ kind: "atom", visible: char.char, out: char.char, first: "a", last: "a", marks: inlineMarks(char.marks) });
      index += 1;
      continue;
    }
    units.push({ kind: "char", visible: char.char, out: char.char, first: char.char, last: char.char, marks: inlineMarks(char.marks) });
    index += 1;
  }

  // Escape literal characters in the context of the whole visible line.
  const line = units.map((unit) => (unit.kind === "atom" ? "a" : unit.visible)).join("");
  const blockSyntax = blockSyntaxOffsets(line, context);
  let offset = 0;
  for (const unit of units) {
    if (unit.kind === "char" && unit.visible.length === 1) unit.out = escapeChar(line, offset, blockSyntax);
    else if (unit.kind === "char") unit.out = unit.visible;
    offset += unit.kind === "atom" ? 1 : unit.visible.length;
  }
  return units;
}

/** Can a delimiter run between `before` and `after` open (left-flanking) or close (right-flanking)? */
function canOpen(before: string, after: string) {
  if (!after || WHITESPACE.test(after)) return false;
  return !PUNCTUATION.test(after) || !before || WHITESPACE.test(before) || PUNCTUATION.test(before);
}
function canClose(before: string, after: string) {
  if (!before || WHITESPACE.test(before)) return false;
  return !PUNCTUATION.test(before) || !after || WHITESPACE.test(after) || PUNCTUATION.test(after);
}

type Range = { mark: InlineMark; from: number; to: number };

function markRanges(units: Unit[]): Range[] {
  const ranges: Range[] = [];
  for (const mark of INLINE_MARKS) {
    for (let index = 0; index < units.length; index++) {
      if (!units[index]!.marks.has(mark)) continue;
      const from = index;
      while (index + 1 < units.length && units[index + 1]!.marks.has(mark)) index += 1;
      ranges.push({ mark, from, to: index });
    }
  }
  return ranges;
}

const isSpace = (unit: Unit) => unit.kind === "char" && WHITESPACE.test(unit.visible);

/**
 * Move whitespace, then punctuation, out of a mark's edges until its
 * delimiters can open and close there. A mark that keeps nothing is dropped.
 */
function normalizeMarks(units: Unit[]) {
  for (const range of markRanges(units)) {
    let { from, to } = range;
    const drop = (index: number) => units[index]!.marks.delete(range.mark);
    while (from <= to) {
      if (isSpace(units[from]!)) {
        drop(from++);
        continue;
      }
      if (isSpace(units[to]!)) {
        drop(to--);
        continue;
      }
      if (!canOpen(edgeChar(units[from - 1]?.last ?? ""), edgeChar(units[from]!.first))) {
        drop(from++);
        continue;
      }
      if (!canClose(edgeChar(units[to]!.last), edgeChar(units[to + 1]?.first ?? ""))) {
        drop(to--);
        continue;
      }
      break;
    }
  }
}

/**
 * Write units with their marks: each mark opens once per range, inner marks
 * close first. With `alternate`, a mark that opens right after a "*" uses
 * "_"/"__", so two delimiter runs do not merge into one ("**a*b***_c_").
 */
function emitUnits(units: Unit[], alternate: { italic: boolean; bold: boolean } = { italic: false, bold: false }) {
  const stack: { mark: InlineMark; delimiter: string }[] = [];
  const endOf = (index: number, mark: InlineMark) => {
    let end = index;
    while (end + 1 < units.length && units[end + 1]!.marks.has(mark)) end += 1;
    return end;
  };
  const close = (entries: { delimiter: string }[]) => entries.reverse().map((entry) => entry.delimiter).join("");
  let out = "";
  units.forEach((unit, index) => {
    const cut = stack.findIndex((entry) => !unit.marks.has(entry.mark));
    if (cut >= 0) out += close(stack.splice(cut));
    const opening = INLINE_MARKS
      .filter((mark) => unit.marks.has(mark) && !stack.some((entry) => entry.mark === mark))
      .sort((left, right) => endOf(index, right) - endOf(index, left));
    for (const mark of opening) {
      const underscore = out.endsWith("*") && (mark === "italic" ? alternate.italic : mark === "bold" && alternate.bold);
      const delimiter = underscore ? DELIMITER[mark].replaceAll("*", "_") : DELIMITER[mark];
      out += delimiter;
      stack.push({ mark, delimiter });
    }
    out += unit.out;
  });
  return out + close(stack);
}

/** Delimiter choices tried in order; the first that reads back is written. */
const EMIT_STYLES = [
  { italic: false, bold: false },
  { italic: true, bold: false },
  { italic: false, bold: true },
  { italic: true, bold: true },
];

/** Visible characters with their marks, whitespace left out: what a reader sees. */
type Cells = string;
const cell = (char: string, marks: Iterable<string>) =>
  WHITESPACE.test(char) ? "" : `${char}\u0001${[...marks].sort().join(",")}\u0002`;

function unitCells(units: Unit[]): Cells {
  return units
    .map((unit) => {
      const marks = unit.kind === "code" ? [...unit.marks, CODE] : [...unit.marks];
      return [...unit.visible].map((char) => cell(char, marks)).join("");
    })
    .join("");
}

type MdNode = {
  type: string;
  value?: string;
  children?: MdNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};
const MDAST_MARK: Record<string, string> = { strong: "bold", emphasis: "italic", delete: "strike" };
const MDAST_SOURCE = new Set(["link", "image", "linkReference", "imageReference", "inlineMath", "html", "footnoteReference"]);

/** What the message renderer shows for one line. */
function rendererCells(markdown: string): Cells {
  rendererParser ??= createRendererParser();
  const tree = rendererParser.parse(markdown) as MdNode;
  let out = "";
  const visit = (node: MdNode, marks: string[]) => {
    if (node.type === "text") {
      for (const char of node.value ?? "") out += cell(char, marks);
    } else if (node.type === "inlineCode") {
      for (const char of node.value ?? "") out += cell(char, [...marks, CODE]);
    } else if (MDAST_SOURCE.has(node.type)) {
      const source = markdown.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? 0);
      for (const char of source) out += cell(char, marks);
    } else {
      const mark = MDAST_MARK[node.type];
      for (const child of node.children ?? []) visit(child, mark ? [...marks, mark] : marks);
    }
  };
  visit(tree, []);
  return out;
}

/** What a restored draft shows for one line. */
function draftCells(markdown: string): Cells {
  const { manager } = engine();
  let out = "";
  const visit = (node: JSONContent) => {
    if (node.type === "text") {
      const marks = (node.marks ?? []).map((mark) => mark.type);
      for (const char of (node.text ?? "").replaceAll(AMP, "&")) out += cell(char, marks);
    }
    node.content?.forEach(visit);
  };
  visit(manager.parse(markdown.replaceAll("&", AMP)));
  return out;
}

/** Does the written line read back as the units, in the renderer and in a restored draft? */
function readsBack(markdown: string, units: Unit[]) {
  const expected = unitCells(units);
  return rendererCells(markdown) === expected && draftCells(markdown) === expected;
}

const cloneUnits = (units: Unit[]) => units.map((unit) => ({ ...unit, marks: new Set(unit.marks) }));
const withoutRange = (units: Unit[], range: Range) => {
  const copy = cloneUnits(units);
  for (let index = range.from; index <= range.to; index++) copy[index]!.marks.delete(range.mark);
  return copy;
};

/** The line written in the first delimiter style that reads back, or null. */
function readableEmit(units: Unit[]) {
  for (const style of EMIT_STYLES) {
    const markdown = emitUnits(units, style);
    if (readsBack(markdown, units)) return markdown;
  }
  return null;
}

/** The Markdown of one line (see the contract at the top of this file). */
function lineSource(pieces: Piece[], context: LineContext): string {
  let units = lineUnits(pieces, context);
  normalizeMarks(units);
  for (;;) {
    const ranges = markRanges(units);
    if (ranges.length === 0 && !units.some((unit) => unit.kind === "code")) return emitUnits(units);
    const markdown = readableEmit(units);
    if (markdown !== null || ranges.length === 0) return markdown ?? emitUnits(units);
    // Leave out the one mark range that Markdown cannot express here, or
    // else the shortest, and check again.
    const byLength = [...ranges].sort((left, right) => left.to - left.from - (right.to - right.from));
    const fixed = byLength.map((range) => withoutRange(units, range)).find((candidate) => readableEmit(candidate) !== null);
    units = fixed ?? withoutRange(units, byLength[0]!);
  }
}

// -- Document -> Markdown -------------------------------------------------------

type Reference = { id: string; label: string };

/** A textblock's lines (split at hard breaks) as pieces; mentions become sentinels. */
function inlinePieces(parent: ProseMirrorNode, references: Reference[]): Piece[][] {
  const lines: Piece[][] = [[]];
  const push = (piece: Piece) => lines[lines.length - 1]!.push(piece);
  parent.forEach((child, _offset, index) => {
    const marks = child.marks.filter((mark) => mark.type.name !== LINK).map((mark) => mark.type.name);
    if (child.isText) {
      if (hrefOf(child)) {
        // A pasted anchor: its Markdown link source.
        const source = neutralize(serializeTextNode(child, parent, index));
        if (source) push({ kind: "source", text: source, marks });
        return;
      }
      neutralize(child.text ?? "").split("\n").forEach((text, line) => {
        if (line > 0) lines.push([]);
        if (text) push({ kind: "text", text, marks });
      });
    } else if (child.type.name === MENTION) {
      const id = typeof child.attrs.id === "string" && child.attrs.id ? child.attrs.id : null;
      const label = typeof child.attrs.label === "string" ? child.attrs.label : "";
      // A mention node without an ID carries no identity: it is text.
      if (id) {
        push({ kind: "atom", text: `${OPEN}${references.push({ id, label }) - 1}${CLOSE}`, label: neutralize(`@${label}`), marks });
      } else if (label) {
        push({ kind: "text", text: neutralize(`@${label}`), marks });
      }
    } else if (child.type.name === HARD_BREAK) {
      lines.push([]);
    }
  });
  return lines;
}

/** A textblock's Markdown: its lines joined with "\n". */
function textblockSource(node: ProseMirrorNode, references: Reference[], context: LineContext) {
  return inlinePieces(node, references).map((pieces) => lineSource(pieces, context)).join("\n");
}

const sourceContent = (source: string): JSONContent[] =>
  source ? [{ type: INLINE_SOURCE, attrs: { source } }] : [];

const isEmptyParagraph = (node: ProseMirrorNode) =>
  node.type.name === PARAGRAPH && node.childCount === 0;

const LINE: LineContext = { lineStart: true, heading: false };

/**
 * Children of a quote or list item. Consecutive lines become one paragraph
 * with "\n" between them; between two such runs the first empty line is
 * the blank line Markdown puts there anyway, further empty lines are kept.
 */
function encodeChildren(parent: ProseMirrorNode, references: Reference[]): JSONContent[] {
  const out: ({ lines: string[] } | { block: JSONContent })[] = [];
  let run: string[] | null = null;
  let pendingEmpty = 0;
  let afterLines = false;
  const flush = () => {
    for (; pendingEmpty > 0; pendingEmpty--) out.push({ block: { type: PARAGRAPH } });
  };
  parent.forEach((child) => {
    if (child.type.name === PARAGRAPH) {
      if (isEmptyParagraph(child)) {
        pendingEmpty += 1;
        run = null;
        return;
      }
      const source = textblockSource(child, references, LINE);
      if (run && pendingEmpty === 0) {
        run.push(source);
        return;
      }
      if (pendingEmpty > 0 && afterLines) pendingEmpty -= 1;
      flush();
      run = [source];
      out.push({ lines: run });
      afterLines = true;
      return;
    }
    flush();
    run = null;
    out.push({ block: encodeBlock(child, references) });
    afterLines = false;
  });
  flush();
  // Join the line runs now that they are complete.
  return out.map((entry) =>
    "lines" in entry ? { type: PARAGRAPH, content: sourceContent(entry.lines.join("\n")) } : entry.block,
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
    const content = sourceContent(
      textblockSource(node, references, name === HEADING ? { lineStart: false, heading: true } : LINE),
    );
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
      entries.push(textblockSource(block, references, LINE));
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
 * Checklists are not composer blocks: a task marker ("- [ ] milk") in plain
 * or older text is read as the literal text of the item.
 */
const TASK_MARKER = /^((?:[ \t]*>)*[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+)\[([ xX])\]/gm;

/**
 * Parse Markdown into the editor's blocks. Inverse of `documentMarkdown`:
 * the newlines between two top-level blocks give the empty lines between
 * them (minus the blank line that separates a block from its neighbours).
 */
function markdownBlocks(markdown: string): JSONContent[] {
  const { manager, marked } = engine();
  const source = markdown.replace(/\r\n?/g, "\n").replace(TASK_MARKER, "$1\\[$2]");
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
