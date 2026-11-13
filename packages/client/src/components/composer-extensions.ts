import { Extension, InputRule } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion from "@tiptap/suggestion";
import { createElement } from "react";
import { EmojiImage } from "./EmojiImage";
import { SuggestionList } from "./SuggestionList";
import { suggestionPopup } from "./suggestion-popup";
import { BLOCK_MENU_ITEMS, filterBlockMenuItems, type BlockMenuItem } from "./block-menu-items";
import { emojiForShortName, searchEmoji, type EmojiEntry } from "../lib/emoji-search";

/** True inside a code block or inline code, where menus and rules stay off. */
function inCode(state: import("@tiptap/pm/state").EditorState, from: number) {
  const $from = state.doc.resolve(from);
  if ($from.parent.type.spec.code) return true;
  return state.doc.rangeHasMark(Math.max(0, from - 1), from + 1, state.schema.marks.code!)
    || $from.marks().some((mark) => mark.type.spec.code);
}

export const BlockMenuPluginKey = new PluginKey("blockMenu");
export const EmojiMenuPluginKey = new PluginKey("emojiMenu");

/**
 * The # block menu. "#" at the start of a line or after a space opens it;
 * typing filters it. "# " plus space still makes a heading (the Heading
 * input rule), because the menu does not allow spaces in its query.
 */
export const BlockMenu = Extension.create<{ items: BlockMenuItem[] }>({
  name: "blockMenu",
  addOptions() {
    return { items: BLOCK_MENU_ITEMS };
  },
  addProseMirrorPlugins() {
    const items = this.options.items;
    return [
      Suggestion<BlockMenuItem>({
        editor: this.editor,
        pluginKey: BlockMenuPluginKey,
        char: "#",
        allowedPrefixes: [" "],
        allow: ({ state, range }) => !inCode(state, range.from),
        items: ({ query }) => filterBlockMenuItems(items, query),
        command: ({ editor, range, props }) => props.run(editor, range),
        render: suggestionPopup(SuggestionList<BlockMenuItem>, (props) => ({
          items: props.items,
          command: props.command,
          editor: props.editor,
          label: "Insert a block",
          testId: "block-menu",
          render: (item: BlockMenuItem) => ({
            key: item.id,
            section: item.section,
            content: [
              createElement("span", { key: "label", className: "min-w-0 flex-1 truncate" }, item.label),
              createElement(
                "span",
                { key: "hint", className: "shrink-0 font-mono text-[0.786rem] text-text-dimmed" },
                item.hint,
              ),
            ],
          }),
        })),
      }),
    ];
  },
});

/** Minimum query (":sm") before the : menu opens. */
const EMOJI_MIN_QUERY = 2;

/**
 * The : emoji menu. Opens after ":" plus two characters, at the start of a
 * line or after whitespace, never after a word character (10:30, URLs) or
 * inside code. Enter/Tab inserts the unicode character.
 */
export const EmojiMenu = Extension.create({
  name: "emojiMenu",
  addProseMirrorPlugins() {
    return [
      Suggestion<EmojiEntry>({
        editor: this.editor,
        pluginKey: EmojiMenuPluginKey,
        char: ":",
        allowedPrefixes: [" ", "\u00a0", "(", "["],
        allow: ({ state, range }) => {
          if (inCode(state, range.from)) return false;
          const query = state.doc.textBetween(range.from + 1, range.to);
          return query.length >= EMOJI_MIN_QUERY && /^[\w+-]+$/.test(query);
        },
        items: ({ query }) => searchEmoji(query, 8),
        command: ({ editor, range, props }) => {
          editor.chain().focus().insertContentAt(range, props.emoji).run();
        },
        render: suggestionPopup(SuggestionList<EmojiEntry>, (props) => ({
          items: props.items,
          command: props.command,
          editor: props.editor,
          label: "Insert an emoji",
          testId: "emoji-menu",
          render: (item: EmojiEntry) => ({
            key: item.shortName,
            content: [
              createElement(EmojiImage, { key: "image", emoji: item.emoji, size: 20 }),
              createElement(
                "span",
                { key: "name", className: "min-w-0 flex-1 truncate font-mono text-[0.857rem]" },
                `:${item.shortName}:`,
              ),
            ],
          }),
        })),
      }),
    ];
  },
  addInputRules() {
    return [
      // A complete ":smile:" converts by itself (not after a word character).
      new InputRule({
        find: /(?:^|[\s([])(:([\w+-]+):)$/,
        handler: ({ state, range, match }) => {
          const entry = emojiForShortName(match[2]!);
          if (!entry || inCode(state, range.from)) return null;
          const start = range.to - match[1]!.length;
          state.tr.insertText(entry.emoji, start, range.to);
        },
      }),
    ];
  },
});

/**
 * Enter rules. Enter sends; inside a list it makes a new item (an empty item
 * leaves the list) and inside a code block it makes a new line (Enter on an
 * empty last line leaves the block). Shift+Enter is always a new line.
 * On touch devices Return writes (a new line or item) and the button sends.
 */
export function createEnterRules(submit: (editor: import("@tiptap/core").Editor) => void) {
  return Extension.create({
    name: "composerEnter",
    // Before the list and code-block keymaps, so every Enter goes through here.
    priority: 1000,
    addKeyboardShortcuts() {
      const touch = () => Boolean(window.matchMedia?.("(pointer: coarse)").matches);
      const newLine = (editor: import("@tiptap/core").Editor) => {
        const { $from } = editor.state.selection;
        if ($from.parent.type.name === "codeBlock") {
          const atEnd = $from.parentOffset === $from.parent.content.size;
          if (atEnd && $from.parent.textContent.endsWith("\n")) {
            // An empty last line leaves the block.
            return editor
              .chain()
              .command(({ tr }) => {
                tr.delete($from.pos - 1, $from.pos);
                return true;
              })
              .exitCode()
              .run();
          }
          return editor.commands.newlineInCode();
        }
        for (let depth = $from.depth; depth > 0; depth--) {
          if ($from.node(depth).type.name === "listItem") {
            // An empty item leaves the list.
            if ($from.parent.content.size === 0) return editor.commands.liftListItem("listItem");
            return editor.commands.splitListItem("listItem");
          }
        }
        return false;
      };
      // An open @, # or : menu owns Enter (its plugin picks the entry).
      const menuOpen = (editor: import("@tiptap/core").Editor) =>
        editor.state.plugins.some((plugin) => {
          const state = plugin.getState(editor.state) as { active?: unknown; range?: unknown } | undefined;
          return Boolean(state && typeof state === "object" && state.active === true && "range" in state);
        });
      return {
        Enter: ({ editor }) => {
          if (menuOpen(editor)) return false;
          if (newLine(editor)) return true;
          if (touch()) return editor.commands.splitBlock();
          submit(editor);
          return true;
        },
        // A new line in the same block: paragraphs split (WebKitGTK renders
        // the caret on the wrong line after trailing <br> elements), list
        // items stay one item, code gets a newline.
        "Shift-Enter": ({ editor }) => {
          if (menuOpen(editor)) return false;
          const { $from } = editor.state.selection;
          if ($from.parent.type.name === "codeBlock") return editor.commands.newlineInCode();
          return editor.commands.splitBlock();
        },
      };
    },
  });
}
