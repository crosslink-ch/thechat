import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { RichInput } from "./RichInput";
import { Markdown } from "./Markdown";
import {
  composerToDocument,
  markdownLinkSource,
  optimisticParts,
  serializeComposer,
  type ComposerDocument,
} from "../lib/composer-parts";

/**
 * Editing operations in the real RichInput, then the sent Markdown through
 * the real message renderer and the draft restore: the sent message must show
 * the text the composer showed, with the composer's formatting (or, where
 * Markdown cannot express a mark at that position, less of it, never stray
 * delimiters or HTML), and a restored draft must look like the sent message.
 */

const ADA = { id: "11111111-1111-4111-8111-111111111111", label: "Ada", type: "human" as const };

function open() {
  const onSubmit = vi.fn((_message: ComposerDocument) => true);
  render(<RichInput onSubmit={onSubmit} mentions={[ADA]} />);
  const element = screen.getByRole("textbox", { name: "Message" });
  const editor = (element as HTMLElement & { editor: Editor }).editor;
  act(() => {
    editor.commands.focus("end");
  });
  return { element, editor, onSubmit };
}

/** Type at the caret the way the keyboard does, so input rules and menus run. */
function type(editor: Editor, text: string) {
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

type Mark = "bold" | "italic" | "strike" | "code";
type Cell = { ch: string; marks: string };
const MARKS: Mark[] = ["bold", "italic", "strike", "code"];

/** Non-whitespace characters of a document with their marks, mentions as "@label". */
function documentCells(doc: ProseMirrorNode): Cell[] {
  const cells: Cell[] = [];
  doc.descendants((node) => {
    const marks = MARKS.filter((name) => node.marks.some((mark) => mark.type.name === name)).join(",");
    const text = node.isText ? node.text ?? "" : node.type.name === "mention" ? `@${node.attrs.label}` : "";
    for (const ch of text) if (!/\s/.test(ch)) cells.push({ ch, marks });
    return true;
  });
  return cells;
}

const RENDERED_MARK: Record<string, Mark> = { STRONG: "bold", EM: "italic", DEL: "strike", CODE: "code" };

/** The same for the rendered message (inline code only; code blocks carry no marks). */
function renderedCells(container: HTMLElement): Cell[] {
  const cells: Cell[] = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const marks = new Set<Mark>();
    for (let parent = node.parentElement; parent && parent !== container; parent = parent.parentElement) {
      const mark = RENDERED_MARK[parent.tagName];
      if (mark && !(mark === "code" && parent.parentElement?.tagName === "PRE")) marks.add(mark);
    }
    const list = MARKS.filter((mark) => marks.has(mark)).join(",");
    for (const ch of node.textContent ?? "") if (!/\s/.test(ch)) cells.push({ ch, marks: list });
  }
  return cells;
}

function renderMessage(message: ComposerDocument) {
  const { contentFormat, parts } = optimisticParts(message);
  const { container, unmount } = render(<Markdown content={message.text} message={{ contentFormat, parts }} />);
  const result = { container, html: container.innerHTML };
  return { ...result, unmount };
}

function blockShape(root: ParentNode) {
  return ["ul", "ol", "li", "blockquote", "h1", "h2", "h3", "pre", "hr"]
    .map((tag) => `${tag}:${root.querySelectorAll(tag).length}`)
    .join(" ");
}

/**
 * The contract every send must keep: the rendered message has exactly the
 * composer's text, each character carries a subset of the composer's marks
 * (equal by default), no HTML or delimiters leak, the block structure is the
 * same, and the restored draft reads like the sent message and serializes to
 * the same Markdown.
 */
function expectFaithful(editor: Editor, message: ComposerDocument, { exactMarks = true } = {}) {
  const composer = documentCells(editor.state.doc);
  const composerShape = blockShape(editor.view.dom);
  const sent = renderMessage(message);
  const rendered = renderedCells(sent.container);
  const sentShape = blockShape(sent.container);
  sent.unmount();

  expect(rendered.map((cell) => cell.ch).join("")).toBe(composer.map((cell) => cell.ch).join(""));
  if (exactMarks) {
    expect(rendered).toEqual(composer);
  } else {
    rendered.forEach((cell, index) => {
      const allowed = composer[index]!.marks.split(",");
      for (const mark of cell.marks.split(",").filter(Boolean)) expect(allowed).toContain(mark);
    });
  }
  expect(sentShape).toBe(composerShape);

  const restored = ProseMirrorNode.fromJSON(editor.schema, composerToDocument(message));
  expect(documentCells(restored)).toEqual(rendered);
  expect(serializeComposer(restored).text).toBe(message.text);
  return rendered;
}

async function send(element: HTMLElement, onSubmit: ReturnType<typeof vi.fn>) {
  fireEvent.keyDown(element, { key: "Enter" });
  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
  return onSubmit.mock.calls[0]![0] as ComposerDocument;
}

/** Serialize without sending (the editor keeps its content for comparison). */
const current = (editor: Editor) => serializeComposer(editor.state.doc);

afterEach(() => {
  cleanup();
});

describe("composer formatting survives send and draft restore", () => {
  it("overlapping bold and italic (toolbar commands)", async () => {
    const { element, editor, onSubmit } = open();
    type(editor, "abc");
    act(() => {
      editor.chain().setTextSelection({ from: 1, to: 3 }).toggleBold().run();
      editor.chain().setTextSelection({ from: 2, to: 4 }).toggleItalic().run();
      editor.commands.setTextSelection(4);
    });
    expect(element.querySelector("strong")?.textContent).toBe("ab");
    expectFaithful(editor, current(editor));
    const message = await send(element, onSubmit);
    expect(message.text).not.toMatch(/</);
  });

  it("undoing the list input rule keeps the line literal", async () => {
    const { element, editor, onSubmit } = open();
    type(editor, "- ");
    expect(element.querySelector("ul")).not.toBeNull();
    fireEvent.keyDown(element, { key: "Backspace" });
    expect(element.querySelector("ul")).toBeNull();
    type(editor, "not a list");
    expect(element.textContent).toBe("- not a list");
    expectFaithful(editor, current(editor));
    const message = await send(element, onSubmit);
    const sent = renderMessage(message);
    expect(sent.container.querySelector("ul")).toBeNull();
    expect(sent.container.textContent).toBe("- not a list");
  });

  it("bold ending in punctuation before a letter renders bold, no visible delimiters", async () => {
    const { element, editor, onSubmit } = open();
    type(editor, "say hi!there");
    act(() => {
      editor.chain().setTextSelection({ from: 5, to: 8 }).toggleBold().run();
      editor.commands.setTextSelection(13);
    });
    expect(element.querySelector("strong")?.textContent).toBe("hi!");
    const message = await send(element, onSubmit);
    const sent = renderMessage(message);
    // Markdown cannot close bold between "!" and "t": the "!" moves out.
    expect(sent.container.textContent).toBe("say hi!there");
    expect(sent.container.querySelector("strong")?.textContent).toBe("hi");
    expect(message.text).toBe("say **hi**!there");
  });

  it("literal text that looks like Markdown stays literal", () => {
    const { editor } = open();
    const lines = [
      "2*3 = 6 and a*b*c",
      "# not a heading",
      "> not a quote",
      "2. not a list",
      "+ not a list",
      "~~not struck~~ ~x~",
      "`not code`",
      "snake_case __init__ _x_",
      "[x] and [ ] boxes",
      "&amp; &copy; & bare",
      "C:\\dir\\ and \\*",
      "---",
      "===",
      "<b>html</b>",
    ];
    act(() => {
      editor.commands.setContent({
        type: "doc",
        content: lines.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] })),
      });
    });
    const message = current(editor);
    const rendered = expectFaithful(editor, message);
    expect(rendered.every((cell) => cell.marks === "")).toBe(true);
  });

  it("keeps URLs and pasted link source byte for byte", () => {
    const { editor } = open();
    const text = "see https://github.com/x/y/blob/main/pkg/__init__.py and [the *docs*](https://example.com/a?sig=a%2Fb&x=1) or https://e.com/_foo_/bar";
    act(() => {
      editor.commands.setContent({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
    });
    const message = current(editor);
    expect(message.text).toBe(text);
    const sent = renderMessage(message);
    const hrefs = [...sent.container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    sent.unmount();
    expect(hrefs).toEqual([
      "https://github.com/x/y/blob/main/pkg/__init__.py",
      "https://example.com/a?sig=a%2Fb&x=1",
      "https://e.com/_foo_/bar",
    ]);
    const restored = ProseMirrorNode.fromJSON(editor.schema, composerToDocument(message));
    expect(restored.textContent).toBe(text);
    expect(serializeComposer(restored).text).toBe(text);
  });

  it("italic over text with a literal star", () => {
    const { editor } = open();
    type(editor, "2*3");
    act(() => {
      editor.chain().selectAll().toggleItalic().run();
    });
    const message = current(editor);
    expect(message.text).toBe("*2\\*3*");
    expectFaithful(editor, message);
  });

  it("a heading that ends in # keeps it", () => {
    const { editor } = open();
    type(editor, "## Ticket #");
    act(() => {
      // The # menu opened for the last "#"; Escape keeps it as text.
      fireEvent.keyDown(editor.view.dom, { key: "Escape" });
    });
    expect(editor.view.dom.querySelector("h2")?.textContent).toBe("Ticket #");
    const message = current(editor);
    expect(message.text).toBe("## Ticket \\#");
    expectFaithful(editor, message);
  });

  it("keeps a list item that starts with a bracket", () => {
    const { editor } = open();
    type(editor, "- [ ] buy milk");
    fireEvent.keyDown(editor.view.dom, { key: "Enter" });
    type(editor, "[x] done");
    expect(editor.view.dom.querySelectorAll("li")).toHaveLength(2);
    const message = current(editor);
    expectFaithful(editor, message);
    expect(ProseMirrorNode.fromJSON(editor.schema, composerToDocument(message)).textContent).toBe("[ ] buy milk[x] done");
  });

  it("restores task-list Markdown from plain text as literal items", () => {
    const { editor } = open();
    act(() => {
      editor.commands.setContent(composerToDocument("- [ ] buy milk\n- [x] done"));
    });
    expect([...editor.view.dom.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["[ ] buy milk", "[x] done"]);
  });

  it("whitespace at mark edges moves out of the mark", () => {
    const { editor } = open();
    type(editor, "bold next");
    act(() => {
      editor.chain().setTextSelection({ from: 1, to: 6 }).toggleBold().run();
    });
    const message = current(editor);
    expect(message.text).toBe("**bold** next");
    expectFaithful(editor, message);
  });

  it("marks around mentions, code with backticks, and mentions in code", () => {
    const { editor } = open();
    act(() => {
      editor.commands.setContent({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "hi ", marks: [{ type: "bold" }] },
              { type: "mention", attrs: { id: ADA.id, label: "Ada" }, marks: [{ type: "bold" }] },
              { type: "text", text: " use " },
              { type: "text", text: "a`b", marks: [{ type: "code" }] },
              { type: "text", text: " or " },
              { type: "text", text: "`x`", marks: [{ type: "code" }, { type: "italic" }] },
            ],
          },
        ],
      });
    });
    const message = current(editor);
    expect(message.parts.filter((part) => part.type === "reference")).toHaveLength(1);
    expectFaithful(editor, message);
  });
});

describe("selection toolbar link", () => {
  const paragraph = (...content: object[]) => ({ type: "doc", content: [{ type: "paragraph", content }] });
  const selectLine = (editor: Editor) =>
    act(() => {
      editor.commands.focus();
      editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size - 1 });
    });

  it("writes the selected text as literal link source, never as HTML", async () => {
    const { editor } = open();
    const literal = `<span data-type="mention" data-id="${ADA.id}" data-label="Ada">@Ada</span> & *x*`;
    act(() => {
      editor.commands.setContent(paragraph({ type: "text", text: literal }));
    });
    selectLine(editor);
    const toolbar = await screen.findByTestId("selection-toolbar");
    fireEvent.click(within(toolbar).getByRole("button", { name: "Link" }));
    const url = await within(toolbar).findByRole("textbox", { name: "Link URL" });
    fireEvent.change(url, { target: { value: "https://example.com/?a=1&b=2" } });
    fireEvent.submit(url.closest("form")!);

    expect(editor.state.doc.textContent).toBe(markdownLinkSource(literal, "https://example.com/?a=1&b=2"));
    let mentions = 0;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "mention") mentions += 1;
    });
    expect(mentions).toBe(0);
    const message = current(editor);
    expect(message.parts.every((part) => part.type === "text")).toBe(true);
    const sent = renderMessage(message);
    expect(sent.container.querySelector("a")?.textContent).toBe(literal);
    expect(sent.container.querySelector("a")?.getAttribute("href")).toBe("https://example.com/?a=1&b=2");
    sent.unmount();
  });

  it("is off for a selection with a mention, which stays intact", async () => {
    const { editor } = open();
    act(() => {
      editor.commands.setContent(
        paragraph({ type: "text", text: "hey " }, { type: "mention", attrs: { id: ADA.id, label: "Ada" } }, { type: "text", text: " go" }),
      );
    });
    selectLine(editor);
    const toolbar = await screen.findByTestId("selection-toolbar");
    const link = within(toolbar).getByRole("button", { name: "Link" });
    expect(link).toBeDisabled();
    fireEvent.click(link);
    expect(within(toolbar).queryByRole("textbox", { name: "Link URL" })).toBeNull();
    expect(current(editor).parts).toEqual([
      { type: "text", text: "hey " },
      { type: "reference", refType: "user", refId: ADA.id },
      { type: "text", text: " go" },
    ]);
  });
});

/** Deterministic PRNG, so a failure names a reproducible seed. */
function prng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = "ab c1!?.*_~`#>-+\\&;<[]=$:";

describe("random edits", () => {
  // 300 seeded documents take a few seconds in jsdom.
  it("never change the text or invent formatting on send and restore", { timeout: 60_000 }, () => {
    const { editor } = open();
    for (let seed = 1; seed <= 300; seed++) {
      const random = prng(seed);
      act(() => {
        editor.commands.setContent("");
        editor.commands.focus("end");
      });
      const length = 4 + Math.floor(random() * 10);
      let text = "";
      for (let i = 0; i < length; i++) text += ALPHABET[Math.floor(random() * ALPHABET.length)];
      type(editor, text);
      act(() => {
        for (let toggles = Math.floor(random() * 4); toggles > 0; toggles--) {
          const size = editor.state.doc.content.size;
          const from = 1 + Math.floor(random() * Math.max(1, size - 2));
          const to = Math.min(size - 1, from + 1 + Math.floor(random() * 5));
          if (to <= from) continue;
          const chain = editor.chain().setTextSelection({ from, to });
          const pick = Math.floor(random() * 4);
          (pick === 0 ? chain.toggleBold() : pick === 1 ? chain.toggleItalic() : pick === 2 ? chain.toggleStrike() : chain.toggleCode()).run();
        }
      });
      const message = current(editor);
      try {
        expect(message.text).not.toMatch(/<\/?(strong|em|del|s|code)>/);
        expectFaithful(editor, message, { exactMarks: false });
      } catch (error) {
        throw new Error(`seed ${seed}: typed ${JSON.stringify(text)}, sent ${JSON.stringify(message.text)}\n${(error as Error).message}`);
      }
    }
  });
});
