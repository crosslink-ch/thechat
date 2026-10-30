import {
  MESSAGE_QUOTE_MAX_LENGTH,
  normalizeQuoteText,
  type MessageQuoteDraft,
} from "@thechat/shared";

/** Message bodies that can be quoted carry their message id in this attribute. */
export const QUOTE_SOURCE_ATTRIBUTE = "data-quote-source";

const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT", "FIGURE",
  "H1", "H2", "H3", "H4", "H5", "H6", "HR", "LI", "OL", "P", "PRE",
  "SECTION", "TABLE", "TR", "UL",
]);

/**
 * Plain text of a selected range as the reader saw it: line breaks between
 * blocks, collapsed source whitespace outside preformatted text, and the TeX
 * source for rendered math. `Selection.toString()` would repeat every formula,
 * because KaTeX renders both a MathML and an HTML copy.
 */
export function quoteTextFromRange(range: Range): string {
  const root = range.commonAncestorContainer;
  const enclosingMath = elementOf(root)?.closest(".katex");
  if (enclosingMath) return mathSource(enclosingMath);

  let text = "";
  const breakLine = () => {
    text = text.replace(/ +$/, "");
    if (text && !text.endsWith("\n")) text += "\n";
  };
  const appendText = (node: Text) => {
    const from = node === range.startContainer ? range.startOffset : 0;
    const to = node === range.endContainer ? range.endOffset : node.data.length;
    let value = node.data.slice(from, to);
    if (!isPreformatted(node)) {
      value = value.replace(/[ \t\n\r\f]+/g, " ");
      if (text === "" || text.endsWith(" ") || text.endsWith("\n")) {
        value = value.replace(/^ /, "");
      }
    }
    text += value;
  };
  const visit = (node: Node) => {
    if (node !== root && !range.intersectsNode(node)) return;
    if (node.nodeType === Node.TEXT_NODE) {
      appendText(node as Text);
      return;
    }
    if (!(node instanceof Element)) {
      node.childNodes.forEach(visit);
      return;
    }
    if (node.tagName === "BR") {
      text += "\n";
      return;
    }
    if (node.classList.contains("katex")) {
      text += mathSource(node);
      return;
    }
    const display = getComputedStyle(node).display;
    if (display === "none") return;
    const block =
      BLOCK_TAGS.has(node.tagName) ||
      (display !== "" && !display.startsWith("inline") && display !== "contents");
    if (block) breakLine();
    node.childNodes.forEach(visit);
    if (block) breakLine();
  };
  visit(root);
  return text;
}

function elementOf(node: Node) {
  return node instanceof Element ? node : node.parentElement;
}

function isPreformatted(node: Text) {
  const parent = node.parentElement;
  if (!parent) return false;
  if (parent.closest("pre")) return true;
  const whiteSpace = getComputedStyle(parent).whiteSpace;
  return whiteSpace.startsWith("pre") || whiteSpace === "break-spaces";
}

function mathSource(katex: Element) {
  const tex = katex
    .querySelector('annotation[encoding="application/x-tex"]')
    ?.textContent?.trim();
  if (tex) return `$$${tex}$$`;
  return katex.querySelector(".katex-html")?.textContent ?? katex.textContent ?? "";
}

/** Cut text to the server limit without splitting a surrogate pair. */
export function clampQuoteText(text: string): string {
  if (text.length <= MESSAGE_QUOTE_MAX_LENGTH) return text;
  let cut = text.slice(0, MESSAGE_QUOTE_MAX_LENGTH - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

export interface SelectionQuote extends MessageQuoteDraft {
  /** The selection limited to the quoted message, for positioning UI. */
  range: Range;
}

/**
 * The quote a selection inside `root` would produce. A selection must cover
 * text in exactly one message body; parts outside that body (the sender name,
 * reactions, the next row after a triple-click) are ignored.
 */
export function quoteFromSelection(
  selection: Selection | null,
  root: HTMLElement,
): SelectionQuote | null {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;
  const sources = Array.from(
    root.querySelectorAll<HTMLElement>(`[${QUOTE_SOURCE_ATTRIBUTE}]`),
  ).filter(
    (source) =>
      range.intersectsNode(source) &&
      rangeWithin(range, source).toString().trim().length > 0,
  );
  if (sources.length !== 1) return null;
  const [source] = sources;
  const messageId = source.getAttribute(QUOTE_SOURCE_ATTRIBUTE);
  if (!messageId) return null;
  const quoted = rangeWithin(range, source);
  const text = clampQuoteText(normalizeQuoteText(quoteTextFromRange(quoted)));
  return text ? { text, messageId, range: quoted } : null;
}

function rangeWithin(range: Range, element: Element) {
  const limited = element.ownerDocument.createRange();
  limited.selectNodeContents(element);
  if (range.compareBoundaryPoints(Range.START_TO_START, limited) > 0) {
    limited.setStart(range.startContainer, range.startOffset);
  }
  if (range.compareBoundaryPoints(Range.END_TO_END, limited) < 0) {
    limited.setEnd(range.endContainer, range.endOffset);
  }
  return limited;
}
