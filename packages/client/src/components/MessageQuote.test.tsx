import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ChatMessage, MessageQuoteDraft } from "@thechat/shared";
import { ChannelChatView } from "./ChannelChatView";
import { InputBar } from "./InputBar";
import { useComposerDraftsStore } from "../stores/composer-drafts";
import { quoteFromSelection } from "../lib/message-quote";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;
  // jsdom has no layout. Give the transcript a viewport and the selection a
  // box inside it so the Reply button can position itself.
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({ top: 0, bottom: 800, left: 0, right: 1000, width: 1000, height: 800 }) as DOMRect;
  Range.prototype.getBoundingClientRect = () =>
    ({ top: 200, bottom: 220, left: 40, right: 240, width: 200, height: 20 }) as DOMRect;
});

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  useComposerDraftsStore.setState({
    drafts: {},
    revisions: {},
    imageDrafts: {},
    attachmentDrafts: {},
    sendingAttachments: {},
    quoteDrafts: {},
  });
});

const SOURCE =
  "Direction matters. A rule like group:eng → tag:vm:22 lets users start connections to the VM.";

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    conversationId: "conversation-1",
    threadId: null,
    senderId: "bot-1",
    senderName: "Koda",
    senderType: "bot",
    content: SOURCE,
    createdAt: "2026-10-30T10:00:00.000Z",
    ...overrides,
  };
}

function selectText(node: Node, start: number, end: number) {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  act(() => {
    document.dispatchEvent(new Event("selectionchange"));
  });
}

function textNodeContaining(root: HTMLElement, text: string) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    if (walker.currentNode.textContent?.includes(text)) return walker.currentNode;
  }
  throw new Error(`No text node contains ${text}`);
}

describe("Replying to selected text", () => {
  it("quotes a selection, sends it with the reply, and shows the full quote on demand", async () => {
    const onSend = vi.fn(() => true);
    const { container } = render(
      <ChannelChatView
        messages={[message({})]}
        loading={false}
        typingUsers={new Map()}
        onSend={onSend}
        draftKey="channel:quote-test"
      />,
    );
    const body = container.querySelector<HTMLElement>(
      '[data-quote-source="11111111-1111-4111-8111-111111111111"]',
    )!;
    const node = textNodeContaining(body, "A rule like");
    const from = node.textContent!.indexOf("A rule like");
    selectText(node, from, from + "A rule like group:eng → tag:vm:22".length);

    fireEvent.click(await screen.findByTestId("selection-reply"));
    expect(screen.queryByTestId("selection-reply")).toBeNull();
    expect(window.getSelection()?.isCollapsed ?? true).toBe(true);

    const chip = screen.getByTestId("quote-draft-card");
    expect(chip).toHaveTextContent("A rule like group:eng → tag:vm:22");

    const editor = container.querySelector<HTMLElement>(".ProseMirror")!;
    act(() => {
      useComposerDraftsStore.getState().setDraft("channel:quote-test", "How?");
    });
    await waitFor(() => expect(editor.textContent).toBe("How?"));
    fireEvent.click(screen.getByTitle("Send message"));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend).toHaveBeenCalledWith("How?", [], {
      text: "A rule like group:eng → tag:vm:22",
      messageId: "11111111-1111-4111-8111-111111111111",
    });
    await waitFor(() => expect(screen.queryByTestId("quote-draft-card")).toBeNull());
  });

  it("renders a sent quote as a card that opens the whole snippet", async () => {
    const long = `${SOURCE} Return traffic for those connections is allowed automatically (stateful), but the VM can't initiate new connections toward the user.`;
    render(
      <ChannelChatView
        messages={[
          message({}),
          message({
            id: "22222222-2222-4222-8222-222222222222",
            senderId: "human-1",
            senderName: "Bruno",
            senderType: "human",
            content: "How does this work at a lower level?",
            quote: {
              text: long,
              messageId: "11111111-1111-4111-8111-111111111111",
            },
            createdAt: "2026-10-30T10:01:00.000Z",
          }),
        ]}
        loading={false}
        typingUsers={new Map()}
        onSend={() => true}
      />,
    );

    const card = screen.getByTestId("message-quote");
    expect(card).toHaveAccessibleName(/^Quote:\s*Direction matters\./);
    fireEvent.click(card);

    const dialog = await screen.findByRole("dialog", { name: "Quote" });
    expect(within(dialog).getByText(long)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close quote" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Closing returns keyboard focus to the card that opened the quote.
    expect(card).toHaveFocus();
  });

  it("offers no Reply for selections spanning two messages or outside message bodies", async () => {
    const { container } = render(
      <ChannelChatView
        messages={[
          message({}),
          message({
            id: "33333333-3333-4333-8333-333333333333",
            content: "A second message from another sender.",
            senderId: "human-2",
            senderName: "Alina",
            senderType: "human",
          }),
        ]}
        loading={false}
        typingUsers={new Map()}
        onSend={() => true}
      />,
    );
    const first = textNodeContaining(container, "Direction matters.");
    const second = textNodeContaining(container, "A second message");
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(second, 8);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    act(() => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(screen.queryByTestId("selection-reply")).toBeNull();

    const sender = textNodeContaining(container, "Alina");
    selectText(sender, 0, 5);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(screen.queryByTestId("selection-reply")).toBeNull();
  });
});

describe("Composer quote drafts", () => {
  const quote: MessageQuoteDraft = {
    text: "Return traffic is allowed statefully.",
    messageId: "11111111-1111-4111-8111-111111111111",
  };

  it("restores the quote together with the text when an optimistic send is rejected", async () => {
    let reject!: (accepted: boolean) => void;
    const onSend = vi
      .fn((): boolean | Promise<boolean> => true)
      .mockReturnValueOnce(new Promise<boolean>((resolve) => (reject = resolve)));
    useComposerDraftsStore.setState({
      drafts: { "dm:quote": "Why?" },
      quoteDrafts: { "dm:quote": quote },
    });
    const { container } = render(
      <InputBar
        convId={undefined}
        draftKey="dm:quote"
        optimisticSend
        onSend={onSend}
        onStop={() => {}}
      />,
    );
    const editor = container.querySelector<HTMLElement>(".ProseMirror")!;
    await waitFor(() => expect(editor.textContent).toBe("Why?"));

    fireEvent.click(screen.getByTitle("Send message"));
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("Why?", undefined, undefined, quote));
    expect(screen.queryByTestId("quote-draft-card")).toBeNull();

    await act(async () => reject(false));
    await waitFor(() => expect(editor.textContent).toBe("Why?"));
    expect(screen.getByTestId("quote-draft-card")).toHaveTextContent(quote.text);
  });

  it("keeps a rejected send's quote off a newer draft typed in the meantime", async () => {
    let reject!: (accepted: boolean) => void;
    const onSend = vi
      .fn((): boolean | Promise<boolean> => true)
      .mockReturnValueOnce(new Promise<boolean>((resolve) => (reject = resolve)));
    useComposerDraftsStore.setState({
      drafts: { "dm:quote": "Why?" },
      quoteDrafts: { "dm:quote": quote },
    });
    const { container } = render(
      <InputBar
        convId={undefined}
        draftKey="dm:quote"
        optimisticSend
        onSend={onSend}
        onStop={() => {}}
      />,
    );
    const editor = container.querySelector<HTMLElement>(".ProseMirror")!;
    await waitFor(() => expect(editor.textContent).toBe("Why?"));
    fireEvent.click(screen.getByTitle("Send message"));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));

    act(() => {
      useComposerDraftsStore.getState().setDraft("dm:quote", "Something else");
    });
    await act(async () => reject(false));

    expect(useComposerDraftsStore.getState().drafts["dm:quote"]).toBe("Something else");
    expect(screen.queryByTestId("quote-draft-card")).toBeNull();
  });

  it("an image-only send replies to the quote and clears it", async () => {
    const onSend = vi.fn(() => true);
    useComposerDraftsStore.setState({
      quoteDrafts: { "dm:quote": quote },
      imageDrafts: {
        "dm:quote": [{ id: "img-1", mimeType: "image/png", base64: "iVBORw0KGgo=" }],
      },
    });
    const { container } = render(
      <InputBar convId={undefined} draftKey="dm:quote" onSend={onSend} onStop={() => {}} />,
    );
    fireEvent.keyDown(container.querySelector(".ProseMirror")!, { key: "Enter" });

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend).toHaveBeenCalledWith(
      "",
      [expect.objectContaining({ id: "img-1" })],
      undefined,
      quote,
    );
    await waitFor(() => expect(screen.queryByTestId("quote-draft-card")).toBeNull());
  });

  it("removes the quote without touching the typed text", async () => {
    useComposerDraftsStore.setState({
      drafts: { "dm:quote": "Keep me" },
      quoteDrafts: { "dm:quote": quote },
    });
    const { container } = render(
      <InputBar convId={undefined} draftKey="dm:quote" onSend={() => true} onStop={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove quote" }));
    expect(screen.queryByTestId("quote-draft-card")).toBeNull();
    expect(useComposerDraftsStore.getState().quoteDrafts["dm:quote"]).toBeUndefined();
    expect(container.querySelector(".ProseMirror")!.textContent).toBe("Keep me");
  });
});

describe("quoteFromSelection", () => {
  function container(html: string) {
    const root = document.createElement("div");
    root.innerHTML = html;
    document.body.append(root);
    return root;
  }

  it("keeps block structure and uses TeX for rendered math instead of duplicated glyphs", () => {
    const root = container(`
      <div data-quote-source="m1"><div class="md-content">
        <p>Energy is <span class="katex"><span class="katex-mathml"><math><semantics><mrow><mi>E</mi></mrow><annotation encoding="application/x-tex">E = mc^2</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">E=mc2</span></span> here.</p>
        <ul><li>first</li><li>second</li></ul>
      </div></div>`);
    const range = document.createRange();
    range.selectNodeContents(root.querySelector(".md-content")!);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    expect(quoteFromSelection(window.getSelection(), root)).toMatchObject({
      messageId: "m1",
      text: "Energy is $$E = mc^2$$ here.\nfirst\nsecond",
    });
    root.remove();
  });

  it("trims a triple-click that runs into the next row down to the message body", () => {
    const root = container(`
      <div data-quote-source="m1"><p>Only this paragraph</p></div>
      <div class="reactions">👍 1</div>`);
    const range = document.createRange();
    range.setStart(root.querySelector("p")!.firstChild!, 0);
    range.setEnd(root.querySelector(".reactions")!, 0);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);

    expect(quoteFromSelection(window.getSelection(), root)?.text).toBe(
      "Only this paragraph",
    );
    root.remove();
  });
});
