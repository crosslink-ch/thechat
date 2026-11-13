import { useState, type FormEvent, type KeyboardEvent } from "react";
import type { Editor } from "@tiptap/core";
import { BubbleMenu } from "@tiptap/react/menus";
import { Bold, Check, Code, Italic, Link, Strikethrough } from "lucide-react";
import { markdownLinkSource } from "../lib/composer-parts";

const buttonClass = (active: boolean) =>
  `flex size-7 cursor-pointer items-center justify-center rounded-md border-none transition-colors duration-100 ${
    active ? "bg-accent/20 text-accent" : "bg-transparent text-text-secondary hover:bg-hover hover:text-text"
  }`;

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

  const mark = (name: string, label: string, Icon: typeof Bold, toggle: () => void) => (
    <button
      key={name}
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={editor.isActive(name)}
      className={buttonClass(editor.isActive(name))}
      onMouseDown={(event) => event.preventDefault()}
      onClick={toggle}
    >
      <Icon size={15} aria-hidden="true" />
    </button>
  );

  const openLink = () => {
    const { from, to } = editor.state.selection;
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
    const text = editor.state.doc.textBetween(linkRange.from, linkRange.to, "");
    const source = markdownLinkSource(text, href.trim());
    if (!source) return;
    setLinkRange(null);
    editor.chain().focus().insertContentAt(linkRange, source).run();
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
              className={`${buttonClass(false)} disabled:cursor-default disabled:opacity-40`}
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
              title="Link"
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
