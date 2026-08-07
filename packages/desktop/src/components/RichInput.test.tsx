import { describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { RichInput, type RichInputHandle } from "./RichInput";

function renderRichInput(initialText?: string) {
  const ref = createRef<RichInputHandle>();
  const onSubmit = vi.fn(() => true);
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

describe("RichInput", () => {
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
