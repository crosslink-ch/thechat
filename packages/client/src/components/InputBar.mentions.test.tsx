import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Editor as TiptapEditor } from "@tiptap/react";
import { InputBar } from "./InputBar";
import { useComposerDraftsStore } from "../stores/composer-drafts";
import type { ComposerDocument } from "../lib/composer-parts";

/**
 * The real Tiptap composer: a mention picked from the @ menu keeps its user
 * ID through a failed send, a scope switch, and a restore.
 */

const KODA = { id: "22222222-2222-4222-8222-222222222222", label: "Koda", type: "bot" as const };
const ADA = { id: "11111111-1111-4111-8111-111111111111", label: "Ada", type: "human" as const };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  useComposerDraftsStore.setState({
    drafts: {},
    revisions: {},
    imageDrafts: {},
    attachmentDrafts: {},
    sendingAttachments: {},
  });
});

function editorElement() {
  return screen.getByRole("textbox", { name: "Message" });
}

describe("InputBar mention drafts (real editor)", () => {
  it("restores a picked mention by ID after a rejected optimistic send", async () => {
    const send = deferred<boolean>();
    const onSend = vi.fn((_message: ComposerDocument | string) => send.promise);
    const draftKey = "account:me:channel:general";
    useComposerDraftsStore.getState().setDraft(draftKey, {
      text: "Hi @Koda",
      labels: { [KODA.id]: "Koda" },
      parts: [
        { type: "text", text: "Hi " },
        { type: "reference", refType: "user", refId: KODA.id },
      ],
    });
    render(
      <InputBar
        convId={undefined}
        draftKey={draftKey}
        onSend={onSend}
        onStop={vi.fn()}
        optimisticSend
        mentions={[KODA, ADA]}
      />,
    );
    // The stored draft opens with an atomic mention node, not "@Koda" text.
    expect(editorElement().querySelector('[data-type="mention"]')?.getAttribute("data-id")).toBe(KODA.id);

    fireEvent.click(screen.getByTitle("Send message"));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]![0]).toMatchObject({
      parts: [
        { type: "text", text: "Hi " },
        { type: "reference", refType: "user", refId: KODA.id },
      ],
    });
    // Optimistic send clears the composer straight away.
    await waitFor(() => expect(editorElement().querySelector('[data-type="mention"]')).toBeNull());

    await act(async () => {
      send.resolve(false);
      await send.promise;
    });

    // The rejected draft comes back with the same reference.
    await waitFor(() =>
      expect(editorElement().querySelector('[data-type="mention"]')?.getAttribute("data-id")).toBe(KODA.id),
    );
    expect(useComposerDraftsStore.getState().drafts[draftKey]?.parts).toEqual([
      { type: "text", text: "Hi " },
      { type: "reference", refType: "user", refId: KODA.id },
    ]);
  });

  it("keeps a mention when the user switches scope and comes back", async () => {
    const firstKey = "account:me:dm:c1:general";
    const secondKey = "account:me:dm:c1:thread:t2";
    useComposerDraftsStore.getState().setDraft(firstKey, {
      text: "@Ada look",
      labels: { [ADA.id]: "Ada" },
      parts: [
        { type: "reference", refType: "user", refId: ADA.id },
        { type: "text", text: " look" },
      ],
    });
    const props = { convId: undefined, onSend: vi.fn(), onStop: vi.fn(), mentions: [KODA, ADA] };
    const { rerender } = render(<InputBar {...props} draftKey={firstKey} />);
    rerender(<InputBar {...props} draftKey={secondKey} />);
    expect(editorElement().querySelector('[data-type="mention"]')).toBeNull();
    rerender(<InputBar {...props} draftKey={firstKey} />);
    expect(editorElement().querySelector('[data-type="mention"]')?.getAttribute("data-id")).toBe(ADA.id);
  });

  it("keeps a draft with a mention when the members have not loaded yet", () => {
    const draftKey = "account:me:channel:loading";
    useComposerDraftsStore.getState().setDraft(draftKey, {
      text: "Hi @Koda",
      labels: { [KODA.id]: "Koda" },
      parts: [
        { type: "text", text: "Hi " },
        { type: "reference", refType: "user", refId: KODA.id },
      ],
    });
    // No mentions prop: the editor has no mention node yet.
    render(<InputBar convId={undefined} draftKey={draftKey} onSend={vi.fn()} onStop={vi.fn()} />);
    expect(editorElement().textContent).toBe("Hi @Koda");
    expect(useComposerDraftsStore.getState().drafts[draftKey]?.text).toBe("Hi @Koda");
  });

  it("keeps an empty line typed after a mention across a scope switch", async () => {
    const firstKey = "account:me:channel:general";
    const secondKey = "account:me:channel:random";
    useComposerDraftsStore.getState().setDraft(firstKey, {
      text: "@Ada look",
      labels: { [ADA.id]: "Ada" },
      parts: [
        { type: "reference", refType: "user", refId: ADA.id },
        { type: "text", text: " look" },
      ],
    });
    const props = { convId: undefined, onSend: vi.fn(), onStop: vi.fn(), mentions: [KODA, ADA] };
    const { rerender } = render(<InputBar {...props} draftKey={firstKey} />);
    // Shift+Enter at the end starts a new, still empty line.
    const editor = editorElement();
    // Tiptap keeps its editor on the editable element.
    const tiptap = (editor as HTMLElement & { editor: TiptapEditor }).editor;
    act(() => {
      tiptap.commands.focus("end");
    });
    fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });
    await waitFor(() => expect(editor.querySelectorAll("p")).toHaveLength(2));
    await waitFor(() =>
      expect(useComposerDraftsStore.getState().drafts[firstKey]?.text).toBe("@Ada look\n"),
    );

    rerender(<InputBar {...props} draftKey={secondKey} />);
    rerender(<InputBar {...props} draftKey={firstKey} />);
    expect(editorElement().querySelectorAll("p")).toHaveLength(2);
    expect(editorElement().querySelector('[data-type="mention"]')?.getAttribute("data-id")).toBe(ADA.id);
  });
});
