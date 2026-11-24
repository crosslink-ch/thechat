import { useState, type FormEvent, type KeyboardEvent } from "react";
import type { Editor } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import { useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { Bold, Check, Code, Italic, Link, Strikethrough } from "lucide-react";
import { markdownLinkSource } from "../lib/composer-parts";

const buttonClass = (active: boolean) =>
  `flex size-7 cursor-pointer items-center justify-center rounded-md border-none transition-colors duration-100 disabled:cursor-default disabled:opacity-40 ${
    active ? "bg-accent/20 text-accent" : "bg-transparent text-text-secondary hover:bg-hover hover:text-text"
  }`;

/**
 * The selected text a link can be made from: one line of plain text. A
 * selection across lines or with a mention has no single text label.
 */
function linkLabel(state: EditorState, from: number, to: number): string | null {
  const $from = state.doc.resolve(from);
  const $to = state.doc.resolve(to);
  if (from === to || !$from.sameParent($to) || $from.parent.type.spec.code) return null;
  let textOnly = true;
  state.doc.nodesBetween(from, to, (node) => {
    if (node.isInline && !node.isText) textOnly = false;
  });
  const text = state.doc.textBetween(from, to, "");
  return textOnly && text.trim() ? text : null;
}

/**
 * Toolbar on a text selection: bold, italic, strike, inline code and link.
 * A link is written as its Markdown source ("[text](url)"), like a pasted
 * link, so the composer shows exactly what is sent. The URL is typed into
 * the toolbar itself: desktop webviews do not reliably show window.prompt.
 */
export function SelectionToolbar({ editor }: { editor: Editor }) {
  /** The selection a link is being written for, while the URL field is open. */
  const [linkRange, setLinkRange] = useState<{ from: number; to: number } | null>(null);
  const [href, setHref] = useState("https://");
  const active = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current.isActive("bold"),
      italic: current.isActive("italic"),
      strike: current.isActive("strike"),
      code: current.isActive("code"),
      linkable:
        linkLabel(current.state, current.state.selection.from, current.state.selection.to) !== null,
    }),
  });

  const mark = (name: "bold" | "italic" | "strike" | "code", label: string, Icon: typeof Bold, toggle: () => void) => (
    <button
      key={name}
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active[name]}
      className={buttonClass(active[name])}
      onMouseDown={(event) => event.preventDefault()}
      onClick={toggle}
    >
      <Icon size={15} aria-hidden="true" />
    </button>
  );

  const openLink = () => {
    const { from, to } = editor.state.selection;
    if (linkLabel(editor.state, from, to) === null) return;
    setHref("https://");
    setLinkRange({ from, to });
  };

  const closeLink = () => {
    setLinkRange(null);
    editor.commands.focus();
  };

  const applyLink = (event: FormEvent) => {
    event.preventDefault();
    if (!linkRange) return;
    const label = linkLabel(editor.state, linkRange.from, linkRange.to);
    const source = label === null ? null : markdownLinkSource(label, href.trim());
    if (!source) return;
    setLinkRange(null);
    // A text node, never HTML: the label is the user's literal text.
    editor.chain().focus().insertContentAt(linkRange, { type: "text", text: source }).run();
  };

  const onLinkKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeLink();
    }
  };

  const linkValid = markdownLinkSource("x", href.trim()) !== null;

  return (
    <BubbleMenu
      editor={editor}
      pluginKey="selectionToolbar"
      shouldShow={({ editor: current, state, from, to }) => {
        if (from === to || !current.isEditable) return false;
        const $from = state.doc.resolve(from);
        // No marks inside a code block, and mentions alone are not text.
        if ($from.parent.type.spec.code) return false;
        return state.doc.textBetween(from, to, "").trim().length > 0;
      }}
      options={{ placement: "top", offset: 6, onHide: () => setLinkRange(null) }}
    >
      <div
        role="toolbar"
        aria-label="Formatting"
        data-testid="selection-toolbar"
        className="flex items-center gap-0.5 rounded-lg border border-border bg-surface/95 p-1 shadow-card backdrop-blur-2xl"
      >
        {linkRange ? (
          <form className="flex items-center gap-1" onSubmit={applyLink}>
            <input
              type="url"
              aria-label="Link URL"
              value={href}
              autoFocus
              onChange={(event) => setHref(event.target.value)}
              onKeyDown={onLinkKeyDown}
              className="h-7 w-56 rounded-md border border-border bg-sunken px-2 text-[0.857rem] text-text outline-none focus:border-border-focus"
            />
            <button
              type="submit"
              aria-label="Apply link"
              title="Apply link"
              disabled={!linkValid}
              className={buttonClass(false)}
            >
              <Check size={15} aria-hidden="true" />
            </button>
          </form>
        ) : (
          <>
            {mark("bold", "Bold", Bold, () => editor.chain().focus().toggleBold().run())}
            {mark("italic", "Italic", Italic, () => editor.chain().focus().toggleItalic().run())}
            {mark("strike", "Strikethrough", Strikethrough, () => editor.chain().focus().toggleStrike().run())}
            {mark("code", "Inline code", Code, () => editor.chain().focus().toggleCode().run())}
            <button
              type="button"
              aria-label="Link"
              title={active.linkable ? "Link" : "Link (select text on one line, without mentions)"}
              disabled={!active.linkable}
              className={buttonClass(false)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={openLink}
            >
              <Link size={15} aria-hidden="true" />
            </button>
          </>
        )}
      </div>
    </BubbleMenu>
  );
}
