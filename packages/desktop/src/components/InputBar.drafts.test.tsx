import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { InputBar } from "./InputBar";
import { useComposerDraftsStore } from "../stores/composer-drafts";

vi.mock("./RichInput", async () => {
  const React = await import("react");

  interface MockRichInputProps {
    initialText?: string;
    onSubmit: (text: string) => void | boolean | Promise<void | boolean>;
    onTextChange?: (text: string) => void;
    onCanSubmitChange?: (canSubmit: boolean) => void;
  }

  const RichInput = React.forwardRef(function MockRichInput(
    {
      initialText = "",
      onSubmit,
      onTextChange,
      onCanSubmitChange,
    }: MockRichInputProps,
    ref: React.ForwardedRef<{
      submit: () => void;
      focus: () => void;
      setText: (text: string) => void;
    }>,
  ) {
    const [text, setText] = React.useState(initialText);
    const textRef = React.useRef(text);
    textRef.current = text;

    const update = (next: string) => {
      textRef.current = next;
      setText(next);
      onTextChange?.(next);
      onCanSubmitChange?.(next.trim().length > 0);
    };

    React.useImperativeHandle(ref, () => ({
      submit: () => {
        const submittedText = textRef.current;
        const value = submittedText.trim();
        if (!value) return;
        const finish = (accepted: void | boolean) => {
          if (accepted !== false && textRef.current === submittedText) {
            update("");
          }
        };
        const result = onSubmit(value);
        if (
          result &&
          typeof (result as PromiseLike<void | boolean>).then === "function"
        ) {
          void Promise.resolve(result).then(finish, () => undefined);
        } else {
          finish(result as void | boolean);
        }
      },
      focus: () => undefined,
      setText: update,
    }));

    return (
      <textarea
        aria-label="Message"
        value={text}
        onChange={(event) => update(event.currentTarget.value)}
      />
    );
  });

  return { RichInput };
});

afterEach(() => {
  useComposerDraftsStore.setState({
    drafts: {},
    revisions: {},
    imageDrafts: {},
    attachmentDrafts: {},
    sendingAttachments: {},
  });
  vi.clearAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("InputBar composer draft scoping", () => {
  it("isolates drafts by scope and restores them when switching back", () => {
    const onSend = vi.fn();
    const onStop = vi.fn();
    const { rerender } = render(
      <InputBar
        convId={undefined}
        draftKey="dm:conversation-1:thread:task-1"
        onSend={onSend}
        onStop={onStop}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "draft for task one" },
    });

    rerender(
      <InputBar
        convId={undefined}
        draftKey="dm:conversation-1:thread:task-2"
        onSend={onSend}
        onStop={onStop}
      />,
    );
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("");

    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "draft for task two" },
    });

    rerender(
      <InputBar
        convId={undefined}
        draftKey="dm:conversation-1:thread:task-1"
        onSend={onSend}
        onStop={onStop}
      />,
    );
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue(
      "draft for task one",
    );
    expect(useComposerDraftsStore.getState().drafts).toEqual({
      "dm:conversation-1:thread:task-1": "draft for task one",
      "dm:conversation-1:thread:task-2": "draft for task two",
    });
  });

  it("isolates local image attachments by scope and restores them", () => {
    const firstKey = "agent:conversation-1";
    const secondKey = "agent:conversation-2";
    useComposerDraftsStore.getState().setImageDrafts(firstKey, [
      {
        id: "image-1",
        mimeType: "image/png",
        base64: "cG5n",
      },
    ]);
    const { container, rerender } = render(
      <InputBar
        convId="conversation-1"
        draftKey={firstKey}
        onSend={() => undefined}
        onStop={() => undefined}
      />,
    );
    expect(container.querySelector('img[src="data:image/png;base64,cG5n"]')).not.toBeNull();

    rerender(
      <InputBar
        convId="conversation-2"
        draftKey={secondKey}
        onSend={() => undefined}
        onStop={() => undefined}
      />,
    );
    expect(container.querySelector("img")).toBeNull();

    rerender(
      <InputBar
        convId="conversation-1"
        draftKey={firstKey}
        onSend={() => undefined}
        onStop={() => undefined}
      />,
    );
    expect(container.querySelector('img[src="data:image/png;base64,cG5n"]')).not.toBeNull();
  });

  it("clears the active draft after it is sent", async () => {
    const onSend = vi.fn();
    render(
      <InputBar
        convId={undefined}
        draftKey="channel:channel-1"
        onSend={onSend}
        onStop={() => undefined}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "ready to send" },
    });
    fireEvent.click(screen.getByTitle("Send message"));

    expect(onSend).toHaveBeenCalledWith("ready to send");
    await waitFor(() =>
      expect(useComposerDraftsStore.getState().drafts).toEqual({}),
    );
  });

  it("clears the editor immediately while send acknowledgement is pending", async () => {
    const send = deferred<boolean>();
    const onSend = vi.fn(() => send.promise);
    const draftKey = "dm:conversation-1:general";
    render(
      <InputBar
        convId="conversation-1"
        draftKey={draftKey}
        onSend={onSend}
        onStop={() => undefined}
        optimisticSend
        sharedUpload={{ conversationId: "conversation-1", token: "token-1" }}
      />,
    );

    const editor = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(editor, { target: { value: "sent optimistically" } });
    fireEvent.click(screen.getByTitle("Send message"));

    expect(onSend).toHaveBeenCalled();
    expect(editor).toHaveValue("");
    expect(useComposerDraftsStore.getState().drafts[draftKey]).toBeUndefined();

    await act(async () => {
      send.resolve(true);
      await send.promise;
    });
  });

  it("keeps acknowledgement-gated drafts for agent chat", async () => {
    const send = deferred<boolean>();
    const draftKey = "agent:new";
    render(
      <InputBar
        convId={undefined}
        draftKey={draftKey}
        onSend={() => send.promise}
        onStop={() => undefined}
      />,
    );

    const editor = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(editor, { target: { value: "agent prompt" } });
    fireEvent.click(screen.getByTitle("Send message"));

    expect(editor).toHaveValue("agent prompt");
    expect(useComposerDraftsStore.getState().drafts[draftKey]).toBe(
      "agent prompt",
    );

    await act(async () => {
      send.resolve(true);
      await send.promise;
    });
    await waitFor(() => expect(editor).toHaveValue(""));
  });

  it("does not clear a newer draft when an earlier shared send succeeds", async () => {
    const send = deferred<boolean>();
    const draftKey = "dm:conversation-1:general";
    render(
      <InputBar
        convId="conversation-1"
        draftKey={draftKey}
        onSend={() => send.promise}
        onStop={() => undefined}
        optimisticSend
        sharedUpload={{ conversationId: "conversation-1", token: "token-1" }}
      />,
    );

    const editor = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(editor, { target: { value: "submitted text" } });
    fireEvent.click(screen.getByTitle("Send message"));
    fireEvent.change(editor, { target: { value: "newer draft" } });

    await act(async () => {
      send.resolve(true);
      await send.promise;
    });

    expect(editor).toHaveValue("newer draft");
    expect(useComposerDraftsStore.getState().drafts[draftKey]).toBe(
      "newer draft",
    );
  });

  it("does not restore submitted text over a newer draft when a shared send fails", async () => {
    const send = deferred<boolean>();
    const draftKey = "dm:conversation-1:general";
    render(
      <InputBar
        convId="conversation-1"
        draftKey={draftKey}
        onSend={() => send.promise}
        onStop={() => undefined}
        optimisticSend
        sharedUpload={{ conversationId: "conversation-1", token: "token-1" }}
      />,
    );

    const editor = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(editor, { target: { value: "submitted text" } });
    fireEvent.click(screen.getByTitle("Send message"));
    fireEvent.change(editor, { target: { value: "newer draft" } });

    await act(async () => {
      send.resolve(false);
      await send.promise;
    });

    expect(editor).toHaveValue("newer draft");
    expect(useComposerDraftsStore.getState().drafts[draftKey]).toBe(
      "newer draft",
    );
  });

  it("restores a failed submission after the composer remounts", async () => {
    const send = deferred<boolean>();
    const onSend = vi.fn(() => send.promise);
    const onStop = vi.fn();
    const firstKey = "dm:conversation-1:thread:task-1";
    const secondKey = "dm:conversation-1:thread:task-2";
    const { rerender } = render(
      <InputBar
        convId="conversation-1"
        draftKey={firstKey}
        onSend={onSend}
        onStop={onStop}
        optimisticSend
        sharedUpload={{ conversationId: "conversation-1", token: "token-1" }}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "submitted text" },
    });
    fireEvent.click(screen.getByTitle("Send message"));
    rerender(
      <InputBar
        convId="conversation-1"
        draftKey={secondKey}
        onSend={onSend}
        onStop={onStop}
        optimisticSend
        sharedUpload={{ conversationId: "conversation-1", token: "token-1" }}
      />,
    );
    rerender(
      <InputBar
        convId="conversation-1"
        draftKey={firstKey}
        onSend={onSend}
        onStop={onStop}
        optimisticSend
        sharedUpload={{ conversationId: "conversation-1", token: "token-1" }}
      />,
    );
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("");

    await act(async () => {
      send.resolve(false);
      await send.promise;
    });

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue(
        "submitted text",
      ),
    );
    expect(useComposerDraftsStore.getState().drafts[firstKey]).toBe(
      "submitted text",
    );
  });

  it("does not let an old remounted send overwrite a newer edit for the same scope", async () => {
    const send = deferred<boolean>();
    const onSend = vi.fn(() => send.promise);
    const onStop = vi.fn();
    const firstKey = "dm:conversation-1:thread:task-1";
    const secondKey = "dm:conversation-1:thread:task-2";
    const { rerender } = render(
      <InputBar
        convId="conversation-1"
        draftKey={firstKey}
        onSend={onSend}
        onStop={onStop}
        optimisticSend
        sharedUpload={{ conversationId: "conversation-1", token: "token-1" }}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "submitted text" },
    });
    fireEvent.click(screen.getByTitle("Send message"));
    rerender(
      <InputBar
        convId="conversation-1"
        draftKey={secondKey}
        onSend={onSend}
        onStop={onStop}
        optimisticSend
        sharedUpload={{ conversationId: "conversation-1", token: "token-1" }}
      />,
    );
    rerender(
      <InputBar
        convId="conversation-1"
        draftKey={firstKey}
        onSend={onSend}
        onStop={onStop}
        optimisticSend
        sharedUpload={{ conversationId: "conversation-1", token: "token-1" }}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
      target: { value: "newer draft" },
    });

    await act(async () => {
      send.resolve(false);
      await send.promise;
    });

    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue(
      "newer draft",
    );
    expect(useComposerDraftsStore.getState().drafts[firstKey]).toBe(
      "newer draft",
    );
  });
});
