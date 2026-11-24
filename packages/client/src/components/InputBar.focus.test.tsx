import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { InputBar } from "./InputBar";
import { requestInputBarFocus, useInputFocusStore } from "../stores/input-focus";

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  useInputFocusStore.setState({ focusTick: 0, claimedTick: 0 });
});

function renderComposer(conversationId: string) {
  const utils = render(
    <InputBar
      convId={conversationId}
      draftKey={`conversation:${conversationId}`}
      onSend={() => true}
      onStop={() => {}}
    />,
  );
  const editor = utils.container.querySelector<HTMLElement>(".ProseMirror");
  if (!editor) throw new Error("ProseMirror editor not found");
  return { ...utils, editor };
}

/** The editor focuses in an animation frame; let a few pass. */
async function settle() {
  for (let frame = 0; frame < 3; frame += 1) {
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  }
}

function focusedField(inDialog: boolean) {
  const field = document.createElement("input");
  if (inDialog) {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.append(field);
    document.body.append(dialog);
  } else {
    document.body.append(field);
  }
  field.focus();
  return field;
}

describe("InputBar focus requests", () => {
  it("a request focuses the open composer", async () => {
    const { editor } = renderComposer("first");
    act(() => requestInputBarFocus());
    await waitFor(() => expect(editor).toHaveFocus());
  });

  it("a composer that opens right after a request takes it", async () => {
    // A quick-switcher jump asks for focus before the destination has rendered.
    act(() => requestInputBarFocus());
    const { editor } = renderComposer("destination");
    await waitFor(() => expect(editor).toHaveFocus());
  });

  it("an old request does not focus composers that open later", async () => {
    const first = renderComposer("first");
    act(() => requestInputBarFocus());
    await waitFor(() => expect(first.editor).toHaveFocus());
    first.unmount();

    const field = focusedField(false);
    renderComposer("later");
    await settle();
    expect(field).toHaveFocus();
  });

  it("never takes focus out of an open dialog", async () => {
    act(() => requestInputBarFocus());
    const field = focusedField(true);
    renderComposer("behind-the-dialog");
    await settle();
    expect(field).toHaveFocus();
  });
});
