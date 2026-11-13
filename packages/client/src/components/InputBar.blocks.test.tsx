import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Editor as TiptapEditor } from "@tiptap/core";
import { InputBar } from "./InputBar";
import { useComposerDraftsStore } from "../stores/composer-drafts";
import { HERMES_FALLBACK_SLASH_COMMANDS } from "../lib/hermes-slash-commands";
import type { MessageInput } from "../lib/composer-parts";

/** The real InputBar and RichInput: blocks, # and : menus, Enter rules. */

const editorElement = () => screen.getByRole("textbox", { name: "Message" });
const tiptap = () => (editorElement() as HTMLElement & { editor: TiptapEditor }).editor;

/** Type at the caret the way the keyboard does, so input rules and menus run. */
function type(text: string) {
  const editor = tiptap();
  for (const char of text) {
    act(() => {
      const { from, to } = editor.state.selection;
      const handled = editor.view.someProp("handleTextInput", (handler) =>
        handler(editor.view, from, to, char, () => editor.state.tr.insertText(char, from, to)),
      );
      if (!handled) editor.view.dispatch(editor.state.tr.insertText(char, from, to));
    });
  }
}
const press = (key: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(editorElement(), { key, ...init });

function renderComposer(props: Partial<Parameters<typeof InputBar>[0]> = {}) {
  const onSend = vi.fn((_message: MessageInput) => true);
  render(
    <InputBar convId={undefined} draftKey={`test:${Math.random()}`} onSend={onSend} onStop={vi.fn()} {...props} />,
  );
  act(() => {
    tiptap().commands.focus("end");
  });
  return { onSend };
}
const sentText = (onSend: ReturnType<typeof vi.fn>, call = 0) => {
  const message = onSend.mock.calls[call]?.[0] as MessageInput | undefined;
  return typeof message === "string" ? message : message?.text;
};

afterEach(() => {
  useComposerDraftsStore.setState({ drafts: {}, revisions: {} });
  vi.unstubAllGlobals();
});

describe("composer live formatting", () => {
  it("converts Markdown shortcuts while typing and sends them as Markdown", async () => {
    const { onSend } = renderComposer();
    type("- one");
    expect(editorElement().querySelector("ul > li")?.textContent).toBe("one");
    press("Enter");
    type("two");
    press("Enter");
    // An empty item leaves the list.
    press("Enter");
    type("**bold** and `code`");
    expect(editorElement().querySelector("strong")?.textContent).toBe("bold");
    expect(editorElement().querySelector("p code")?.textContent).toBe("code");
    expect(onSend).not.toHaveBeenCalled();
    press("Enter");
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(sentText(onSend)).toBe("- one\n- two\n\n**bold** and `code`");
  });

  it("makes quotes, numbered lists and headings from their prefixes", () => {
    renderComposer();
    type("> quoted");
    expect(editorElement().querySelector("blockquote")?.textContent).toBe("quoted");
    act(() => {
      tiptap().commands.setContent("");
    });
    type("1. first");
    expect(editorElement().querySelector("ol > li")?.textContent).toBe("first");
    act(() => {
      tiptap().commands.setContent("");
    });
    // "# " plus space still makes a heading, even with the # menu.
    type("# Title");
    expect(editorElement().querySelector("h1")?.textContent).toBe("Title");
    expect(document.querySelector('[data-testid="block-menu"]')).toBeNull();
    act(() => {
      tiptap().commands.setContent("");
    });
    type("---");
    expect(editorElement().querySelector("hr")).not.toBeNull();
    act(() => {
      tiptap().commands.setContent("");
    });
    type("~~gone~~ *soft*");
    expect(editorElement().querySelector("s")?.textContent).toBe("gone");
    expect(editorElement().querySelector("em")?.textContent).toBe("soft");
  });

  it("keeps Enter inside a code block until an empty last line", async () => {
    const { onSend } = renderComposer();
    type("```");
    type(" ");
    expect(editorElement().querySelector("pre")).not.toBeNull();
    type("a = 1");
    press("Enter");
    type("b = 2");
    expect(onSend).not.toHaveBeenCalled();
    press("Enter");
    // Enter on the empty last line leaves the block.
    press("Enter");
    expect(editorElement().querySelector("pre")?.textContent).toBe("a = 1\nb = 2");
    type("after");
    press("Enter");
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(sentText(onSend)).toBe("```\na = 1\nb = 2\n```\n\nafter");
  });

  it("sends with Enter when a # or : suggestion matches nothing", async () => {
    const { onSend } = renderComposer();
    type("fixed in #42");
    expect(screen.queryByTestId("block-menu")).toBeNull();
    press("Enter");
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(sentText(onSend)).toBe("fixed in #42");
    type("ok :xy");
    expect(screen.queryByTestId("emoji-menu")).toBeNull();
    press("Enter");
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2));
    expect(sentText(onSend, 1)).toBe("ok :xy");
  });

  it("makes Shift+Enter a new line everywhere, never a send", () => {
    const { onSend } = renderComposer();
    type("- item");
    press("Enter", { shiftKey: true });
    type("same item");
    expect(editorElement().querySelectorAll("li")).toHaveLength(1);
    expect(editorElement().querySelectorAll("li p")).toHaveLength(2);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps touch devices writing on Return: new item, no send", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(pointer: coarse)" }));
    const { onSend } = renderComposer();
    type("hello");
    press("Enter");
    expect(editorElement().querySelectorAll("p")).toHaveLength(2);
    type("- a");
    press("Enter");
    expect(editorElement().querySelectorAll("li")).toHaveLength(2);
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe("# block menu", () => {
  it("opens at the start of a line, filters, and inserts by keyboard", async () => {
    const { onSend } = renderComposer();
    type("#co");
    const menu = await screen.findByTestId("block-menu");
    expect([...menu.querySelectorAll('[role="option"]')].map((option) => option.textContent)).toEqual([
      "Code block```",
    ]);
    press("Enter");
    await waitFor(() => expect(editorElement().querySelector("pre")).not.toBeNull());
    expect(screen.queryByTestId("block-menu")).toBeNull();
    expect(editorElement().textContent).toBe("");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("lists every block, moves with the arrows, picks with Tab and closes on Escape", async () => {
    renderComposer();
    type("#");
    const menu = await screen.findByTestId("block-menu");
    expect([...menu.querySelectorAll('[role="option"]')].map((option) => option.getAttribute("data-suggestion-option")))
      .toEqual(["heading", "bulletList", "orderedList", "blockquote", "codeBlock", "divider"]);
    press("ArrowDown");
    press("ArrowDown");
    await waitFor(() =>
      expect(menu.querySelector('[aria-selected="true"]')?.getAttribute("data-suggestion-option")).toBe("orderedList"),
    );
    press("Tab");
    await waitFor(() => expect(editorElement().querySelector("ol")).not.toBeNull());

    act(() => {
      tiptap().commands.setContent("");
      tiptap().commands.focus("end");
    });
    type("#");
    await screen.findByTestId("block-menu");
    press("Escape");
    await waitFor(() => expect(screen.queryByTestId("block-menu")).toBeNull());
    expect(editorElement().textContent).toBe("#");
  });

  it("picks with the mouse", async () => {
    renderComposer();
    type("hello #di");
    const option = await screen.findByRole("option", { name: /Divider/ });
    fireEvent.click(option);
    await waitFor(() => expect(editorElement().querySelector("hr")).not.toBeNull());
  });

  it("turns a line with a mention into code without losing the name", async () => {
    renderComposer({ mentions: [{ id: "11111111-1111-4111-8111-111111111111", label: "Ada", type: "human" }] });
    type("hey @Ad");
    await screen.findByTestId("mention-menu");
    press("Enter");
    await waitFor(() => expect(editorElement().querySelector('[data-type="mention"]')).not.toBeNull());
    type("look #co");
    await screen.findByTestId("block-menu");
    press("Enter");
    await waitFor(() => expect(editorElement().querySelector("pre")).not.toBeNull());
    expect(editorElement().querySelector("pre")?.textContent).toBe("hey @Ada look ");
  });

  it("does not open after a word character or inside code", () => {
    renderComposer();
    type("issue#12");
    expect(screen.queryByTestId("block-menu")).toBeNull();
    act(() => {
      tiptap().commands.setContent("");
    });
    type("```");
    type(" ");
    type("#x");
    expect(screen.queryByTestId("block-menu")).toBeNull();
  });
});

describe(": emoji menu", () => {
  it("shows matches after two characters and inserts the unicode emoji", async () => {
    const { onSend } = renderComposer();
    type("hi :s");
    expect(screen.queryByTestId("emoji-menu")).toBeNull();
    type("mile");
    const menu = await screen.findByTestId("emoji-menu");
    // The exact short name ranks first.
    expect(menu.querySelector('[data-suggestion-option]')?.getAttribute("data-suggestion-option")).toBe("smile");
    expect(menu.querySelector("[data-emoji-image], [data-emoji-loading], [data-emoji-fallback]")).not.toBeNull();
    press("Enter");
    await waitFor(() => expect(editorElement().textContent).toBe("hi 😄"));
    expect(onSend).not.toHaveBeenCalled();
  });

  it("picks with Tab and with the mouse", async () => {
    renderComposer();
    type(":thu");
    await screen.findByTestId("emoji-menu");
    press("Tab");
    await waitFor(() => expect(editorElement().textContent).toBe("👍"));
    type(" :heart");
    const option = (await screen.findByTestId("emoji-menu")).querySelector<HTMLElement>('[data-suggestion-option="heart"]')!;
    fireEvent.click(option);
    await waitFor(() => expect(editorElement().textContent).toBe("👍 ❤️"));
  });

  it("converts a complete :name: by itself", () => {
    renderComposer();
    type("ok :tada: ");
    expect(editorElement().textContent).toBe("ok 🎉 ");
  });

  it("stays closed for times, URLs, unknown names and code", () => {
    renderComposer();
    type("at 10:30 see https://example.com:8080 :zzzzqq");
    expect(screen.queryByTestId("emoji-menu")).toBeNull();
    act(() => {
      tiptap().commands.setContent("");
      tiptap().commands.focus("end");
    });
    type("`:smile:`");
    expect(editorElement().textContent).toBe(":smile:");
  });
});

describe("slash commands with the block composer", () => {
  it("still opens and runs / commands in a Hermes DM", async () => {
    const onSend = vi.fn((_message: MessageInput) => true);
    render(
      <InputBar
        convId={undefined}
        draftKey="test:hermes"
        onSend={onSend}
        onStop={vi.fn()}
        slashCommands={HERMES_FALLBACK_SLASH_COMMANDS}
      />,
    );
    act(() => {
      tiptap().commands.focus("end");
    });
    press("/");
    type("/he");
    await screen.findByTestId("slash-command-menu");
    press("Enter");
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(sentText(onSend)).toBe("/help");
  });
});
