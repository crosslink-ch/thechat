import type { Editor } from "@tiptap/core";
import { BubbleMenu } from "@tiptap/react/menus";
import { Bold, Code, Italic, Link, Strikethrough } from "lucide-react";
import { markdownLinkSource } from "../lib/composer-parts";

const buttonClass = (active: boolean) =>
  `flex size-7 cursor-pointer items-center justify-center rounded-md border-none transition-colors duration-100 ${
    active ? "bg-accent/20 text-accent" : "bg-transparent text-text-secondary hover:bg-hover hover:text-text"
  }`;

/**
 * Toolbar on a text selection: bold, italic, strike, inline code and link.
 * A link is written as its Markdown source ("[text](url)"), like a pasted
 * link, so the composer shows exactly what is sent.
 */
export function SelectionToolbar({ editor }: { editor: Editor }) {
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

  const addLink = () => {
    const { from, to } = editor.state.selection;
    const text = editor.state.doc.textBetween(from, to, "");
    const href = window.prompt("Link URL", "https://")?.trim();
    if (!href) return;
    const source = markdownLinkSource(text, href);
    if (!source) return;
    editor.chain().focus().insertContentAt({ from, to }, source).run();
  };

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
      options={{ placement: "top", offset: 6 }}
    >
      <div
        role="toolbar"
        aria-label="Formatting"
        data-testid="selection-toolbar"
        className="flex items-center gap-0.5 rounded-lg border border-border bg-surface/95 p-1 shadow-card backdrop-blur-2xl"
      >
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
          onClick={addLink}
        >
          <Link size={15} aria-hidden="true" />
        </button>
      </div>
    </BubbleMenu>
  );
}
