import { describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { Markdown } from "./Markdown";
import { RichInput, type RichInputHandle } from "./RichInput";

function renderRichInput(initialText?: string) {
  const ref = createRef<RichInputHandle>();
  const onSubmit = vi.fn((_text: string) => true);
  const onTextChange = vi.fn();
  const utils = render(
    <RichInput
      ref={ref}
      onSubmit={onSubmit}
      onTextChange={onTextChange}
      initialText={initialText}
    />,
  );
  const editor = utils.container.querySelector<HTMLElement>(".ProseMirror");
  if (!editor) throw new Error("ProseMirror editor not found");
  return { ...utils, ref, onSubmit, onTextChange, editor };
}

const LINK_LABEL = "KGSP 18-140 I V.mp4";
const LINK_URL = "https://example.com/?file=KGSP%2018-140%20I%20V.mp4&e=Demo123&download=1#preview";

// Exercise ProseMirror's actual clipboard HTML parser, not mocked getText.
function pasteHtml(editor: HTMLElement, html: string, text: string) {
  fireEvent.paste(editor, {
    clipboardData: { getData: (type: string) => type === "text/html" ? html : type === "text/plain" ? text : "", files: [] },
  });
}

describe("RichInput", () => {
  it("preserves a named pasted link destination when submitted with Enter", () => {
    const { editor, onSubmit } = renderRichInput();
    pasteHtml(editor, `<a href="${LINK_URL}">${LINK_LABEL}</a>`, LINK_LABEL);
    expect(editor.querySelector("a")?.getAttribute("href")).toBe(LINK_URL);
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith(`[${LINK_LABEL}](${LINK_URL})`);
  });
  it.each([LINK_URL, "http://example.com/path", "www.example.com/path", "example.com/path"])("leaves literal/autolinked URL %s unchanged", (url) => {
    const { editor, ref, onSubmit, onTextChange } = renderRichInput();
    pasteHtml(editor, "", url);
    expect(onTextChange).toHaveBeenLastCalledWith(url);
    act(() => ref.current!.submit());
    expect(onSubmit).toHaveBeenCalledWith(url);
  });

  it("preserves an explicit destination even when the label looks like a bare URL", () => {
    const { editor, ref, onSubmit } = renderRichInput();
    pasteHtml(editor, '<a href="http://www.example.com/path">www.example.com/path</a>', "www.example.com/path");
    expect(editor.querySelector("a")?.getAttribute("href")).toBe("http://www.example.com/path");
    act(() => ref.current!.submit());
    expect(onSubmit).toHaveBeenCalledWith("[www.example.com/path](http://www.example.com/path)");
    const message = render(<Markdown content={onSubmit.mock.calls[0][0]} />);
    expect(message.container.querySelector("a")?.getAttribute("href")).toBe("http://www.example.com/path");
  });

  it("renders one link for an anchor split across underline marks, preserving surrounding paragraphs", () => {
    const { editor, ref, onSubmit, onTextChange } = renderRichInput();
    pasteHtml(editor, `<p>Before <a href="${LINK_URL}">KGSP <u>18-140</u> I V.mp4</a> after</p><p>Next <a href="https://example.org/other">other</a>.</p>`, "");
    const expected = `Before [${LINK_LABEL}](${LINK_URL}) after\nNext [other](https://example.org/other).`;
    expect(onTextChange).toHaveBeenLastCalledWith(expected);
    act(() => ref.current!.submit());
    expect(onSubmit).toHaveBeenCalledWith(expected);
    const message = render(<Markdown content={onSubmit.mock.calls[0][0]} />);
    const links = message.container.querySelectorAll("a");
    expect(links).toHaveLength(2);
    expect(links[0].textContent).toBe(LINK_LABEL);
    expect(links[0].getAttribute("href")).toBe(LINK_URL);
    expect(links[1].getAttribute("href")).toBe("https://example.org/other");
  });

  it("reversibly escapes link label syntax and destination parentheses/entities", () => {
    const label = "[draft] \\u005c **bold** _under_ ~~strike~~ `code` $$math$$ &copy; <tag>";
    const href = "https://EXAMPLE.com:443/a(b))?sig=a%2Fb%2fc&copy;=literal&x=one#Frag";
    const anchor = document.createElement("a");
    anchor.setAttribute("href", href);
    anchor.textContent = label;
    const { editor, ref, onSubmit } = renderRichInput();
    pasteHtml(editor, anchor.outerHTML, label);
    act(() => ref.current!.submit());
    const message = render(<Markdown content={onSubmit.mock.calls[0][0]} />);
    const links = message.container.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe(href);
    expect(links[0].textContent).toBe(label);
    expect(links[0].querySelector("strong, em, del, code, .katex")).toBeNull();
  });

  it.each(["!", "Look!", "\\\\!", "\\\\\\\\!"])("does not turn a named link after %s into an image", (prefix) => {
    const { editor, ref, onSubmit } = renderRichInput();
    pasteHtml(editor, `<p>${prefix}<a href="${LINK_URL}">${LINK_LABEL}</a></p>`, "");
    act(() => ref.current!.submit());
    const message = render(<Markdown content={onSubmit.mock.calls[0][0]} />);
    expect(message.container.querySelector("img")).toBeNull();
    expect(message.container.querySelector("a")?.getAttribute("href")).toBe(LINK_URL);
    expect(message.container.querySelector("a")?.textContent).toBe(LINK_LABEL);
  });

  it.each(["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,bad", "ftp://example.com/file", "/relative/file"])("does not export an out-of-scope destination %s", (href) => {
    const { editor, ref, onSubmit } = renderRichInput();
    pasteHtml(editor, `<a href="${href}">safe label</a>`, "safe label");
    act(() => ref.current!.submit());
    expect(onSubmit).toHaveBeenCalledWith("safe label");
    const message = render(<Markdown content={onSubmit.mock.calls[0][0]} />);
    expect(message.container.querySelector("a, img")).toBeNull();
  });

  it("does not make whitespace-only pasted link labels sendable", () => {
    const ref = createRef<RichInputHandle>();
    const onSubmit = vi.fn();
    const onCanSubmitChange = vi.fn();
    const onEmptySubmitAttempt = vi.fn(() => false);
    const { getByRole } = render(<RichInput ref={ref} onSubmit={onSubmit} onCanSubmitChange={onCanSubmitChange} onEmptySubmitAttempt={onEmptySubmitAttempt} />);
    pasteHtml(getByRole("textbox"), `<a href="${LINK_URL}">&nbsp;&nbsp;</a>`, "  ");
    expect(onCanSubmitChange).toHaveBeenLastCalledWith(false);
    act(() => ref.current!.submit());
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onEmptySubmitAttempt).toHaveBeenCalledTimes(1);
  });

  it("keeps generated and ordinary Markdown literal through initialText and setText restoration", () => {
    const original = renderRichInput();
    pasteHtml(original.editor, `<a href="${LINK_URL}">${LINK_LABEL}</a>`, LINK_LABEL);
    const draft = original.onTextChange.mock.lastCall![0];
    original.unmount();
    const restored = renderRichInput(draft);
    expect(restored.editor.textContent).toBe(draft);
    expect(restored.editor.querySelector("a")).toBeNull();
    act(() => restored.ref.current!.setText(draft));
    act(() => restored.ref.current!.submit());
    expect(restored.onSubmit).toHaveBeenLastCalledWith(`[${LINK_LABEL}](${LINK_URL})`);
    const handwritten = "**bold** [already](https://example.com/a) `code` <b>literal</b>";
    act(() => restored.ref.current!.setText(handwritten));
    act(() => restored.ref.current!.submit());
    expect(restored.onSubmit).toHaveBeenLastCalledWith(handwritten);
  });

  it("retains mention and hard-break schema serialization beside a named link", () => {
    const onSubmit = vi.fn();
    const ref = createRef<RichInputHandle>();
    const { getByRole } = render(<RichInput ref={ref} onSubmit={onSubmit} mentions={[]} />);
    pasteHtml(getByRole("textbox"), `<p><span data-type="mention" data-id="ada" data-label="Ada">@Ada</span> see<br><a href="${LINK_URL}">${LINK_LABEL}</a></p>`, "");
    act(() => ref.current!.submit());
    expect(onSubmit).toHaveBeenCalledWith(`@Ada see\n[${LINK_LABEL}](${LINK_URL})`);
  });

  it("retains named links after rejection and protects a newer href while submit is pending", async () => {
    let settle!: (accepted: boolean) => void;
    const onSubmit = vi.fn(() => new Promise<boolean>((resolve) => { settle = resolve; }));
    const ref = createRef<RichInputHandle>();
    const { getByRole } = render(<RichInput ref={ref} onSubmit={onSubmit} />);
    const editor = getByRole("textbox");
    pasteHtml(editor, `<a href="${LINK_URL}">${LINK_LABEL}</a>`, LINK_LABEL);
    act(() => ref.current!.submit());
    await act(async () => settle(false));
    expect(editor.querySelector("a")?.getAttribute("href")).toBe(LINK_URL);
    fireEvent.keyDown(editor, { key: "Enter" });
    act(() => ref.current!.setText(""));
    const newer = `${LINK_URL}-new`;
    pasteHtml(editor, `<a href="${newer}">${LINK_LABEL}</a>`, LINK_LABEL);
    await act(async () => settle(true));
    expect(editor.querySelector("a")?.getAttribute("href")).toBe(newer);
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit).toHaveBeenLastCalledWith(`[${LINK_LABEL}](${LINK_URL})`);
  });

  it("exposes a named multiline textbox to assistive technology", () => {
    const { getByRole } = renderRichInput();
    expect(getByRole("textbox", { name: "Message" })).toHaveAttribute("aria-multiline", "true");
  });
  it("renders an initial multiline draft", () => {
    const { editor } = renderRichInput("first line\nsecond line");

    expect(editor.textContent).toBe("first linesecond line");
    expect(editor.querySelectorAll("p")).toHaveLength(2);
  });

  it("round-trips multiline text with single newlines", () => {
    const { ref, onSubmit } = renderRichInput();

    ref.current!.setText("hello\nworld");
    ref.current!.submit();

    expect(onSubmit).toHaveBeenCalledWith("hello\nworld");
  });

  it("submits on Enter", () => {
    const { ref, onSubmit, onTextChange, editor } = renderRichInput();

    ref.current!.setText("hello");
    fireEvent.keyDown(editor, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledWith("hello");
    expect(onTextChange).toHaveBeenLastCalledWith("");
  });

  // Regression: Shift+Enter used to insert hard breaks; WebKitGTK renders the
  // caret on the wrong line after trailing <br> elements, leaving the cursor
  // stuck one line below the text. Paragraph splits keep the caret in a real
  // block so it tracks every new line.
  it("splits a new paragraph for each Shift+Enter", () => {
    const { ref, onSubmit, editor } = renderRichInput();

    ref.current!.setText("hello");
    fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });
    expect(editor.querySelectorAll("p")).toHaveLength(2);

    fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });
    expect(editor.querySelectorAll("p")).toHaveLength(3);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("retains text after a rejected submit and clears it after an accepted retry", async () => {
    let rejectFirst!: (accepted: boolean) => void;
    const onSubmit = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<boolean>((resolve) => {
          rejectFirst = resolve;
        }),
      )
      .mockResolvedValueOnce(true);
    const ref = createRef<RichInputHandle>();
    const { container } = render(<RichInput ref={ref} onSubmit={onSubmit} />);
    const editor = container.querySelector<HTMLElement>(".ProseMirror");
    if (!editor) throw new Error("ProseMirror editor not found");

    ref.current!.setText("retryable prompt");
    ref.current!.submit();
    ref.current!.submit();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(editor.textContent).toBe("retryable prompt");

    await act(async () => rejectFirst(false));
    expect(editor.textContent).toBe("retryable prompt");

    ref.current!.submit();
    await waitFor(() => expect(editor.textContent).toBe(""));
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("does not erase edits made while an accepted submit is pending", async () => {
    let accept!: (accepted: boolean) => void;
    const onSubmit = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          accept = resolve;
        }),
    );
    const ref = createRef<RichInputHandle>();
    const { container } = render(<RichInput ref={ref} onSubmit={onSubmit} />);
    const editor = container.querySelector<HTMLElement>(".ProseMirror");
    if (!editor) throw new Error("ProseMirror editor not found");

    ref.current!.setText("submitted prompt");
    ref.current!.submit();
    ref.current!.setText("newer local edit");
    await act(async () => accept(true));

    expect(editor.textContent).toBe("newer local edit");
  });
});
