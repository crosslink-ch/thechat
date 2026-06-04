import { describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { fireEvent, render } from "@testing-library/react";
import { RichInput, type RichInputHandle } from "./RichInput";

function renderRichInput() {
  const ref = createRef<RichInputHandle>();
  const onSubmit = vi.fn();
  const utils = render(<RichInput ref={ref} onSubmit={onSubmit} />);
  const editor = utils.container.querySelector<HTMLElement>(".ProseMirror");
  if (!editor) throw new Error("ProseMirror editor not found");
  return { ...utils, ref, onSubmit, editor };
}

describe("RichInput", () => {
  it("round-trips multiline text with single newlines", () => {
    const { ref, onSubmit } = renderRichInput();

    ref.current!.setText("hello\nworld");
    ref.current!.submit();

    expect(onSubmit).toHaveBeenCalledWith("hello\nworld");
  });

  it("submits on Enter", () => {
    const { ref, onSubmit, editor } = renderRichInput();

    ref.current!.setText("hello");
    fireEvent.keyDown(editor, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledWith("hello");
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
});
