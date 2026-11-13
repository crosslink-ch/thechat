import type { Editor, Range } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";

/**
 * Entries of the # block menu. Each entry turns the current line into a
 * block. The list is data so other sections (e.g. channels) can be added
 * later by contributing more entries with their own `section`.
 */
export interface BlockMenuItem {
  id: string;
  section: string;
  label: string;
  /** Extra words the filter matches, e.g. "ul" for a bullet list. */
  keywords: string[];
  /** Markdown the block is written as, shown as a hint. */
  hint: string;
  run: (editor: Editor, range: Range) => void;
}

const chainAt = (editor: Editor, range: Range) =>
  editor.chain().focus().deleteRange(range);

/**
 * A code block holds only text, and converting a line drops inline nodes:
 * its mentions become their readable "@name" first, so no name disappears.
 */
const mentionsAsText = ({ tr }: { tr: Transaction }) => {
  const { $from } = tr.selection;
  const start = $from.start();
  const mentions: { pos: number; text: string }[] = [];
  $from.parent.forEach((child, offset) => {
    if (child.type.name === "mention") mentions.push({ pos: start + offset, text: `@${child.attrs.label ?? ""}` });
  });
  for (const { pos, text } of mentions.reverse()) tr.replaceWith(pos, pos + 1, tr.doc.type.schema.text(text));
  return true;
};

export const BLOCK_MENU_ITEMS: BlockMenuItem[] = [
  {
    id: "heading",
    section: "Blocks",
    label: "Heading",
    keywords: ["title", "h1", "h2"],
    hint: "#",
    run: (editor, range) => chainAt(editor, range).setNode("heading", { level: 2 }).run(),
  },
  {
    id: "bulletList",
    section: "Blocks",
    label: "Bullet list",
    keywords: ["ul", "unordered", "list"],
    hint: "-",
    run: (editor, range) => chainAt(editor, range).toggleBulletList().run(),
  },
  {
    id: "orderedList",
    section: "Blocks",
    label: "Numbered list",
    keywords: ["ol", "ordered", "list", "number"],
    hint: "1.",
    run: (editor, range) => chainAt(editor, range).toggleOrderedList().run(),
  },
  {
    id: "blockquote",
    section: "Blocks",
    label: "Quote",
    keywords: ["blockquote", "citation"],
    hint: ">",
    run: (editor, range) => chainAt(editor, range).toggleBlockquote().run(),
  },
  {
    id: "codeBlock",
    section: "Blocks",
    label: "Code block",
    keywords: ["code", "pre", "snippet"],
    hint: "```",
    run: (editor, range) => chainAt(editor, range).command(mentionsAsText).toggleCodeBlock().run(),
  },
  {
    id: "divider",
    section: "Blocks",
    label: "Divider",
    keywords: ["hr", "rule", "line", "separator"],
    hint: "---",
    run: (editor, range) => chainAt(editor, range).setHorizontalRule().run(),
  },
];

/** Entries whose label or keywords start with (or contain) the query. */
export function filterBlockMenuItems(items: readonly BlockMenuItem[], query: string) {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return [...items];
  const words = (item: BlockMenuItem) => [item.label.toLocaleLowerCase(), ...item.keywords];
  const starts = items.filter((item) =>
    words(item).some((word) => word.split(/\s+/).some((part) => part.startsWith(q))),
  );
  const contains = items.filter(
    (item) => !starts.includes(item) && words(item).some((word) => word.includes(q)),
  );
  return [...starts, ...contains];
}
