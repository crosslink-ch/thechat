import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { InputBar } from "./InputBar";
import type { HermesSlashCommand } from "../lib/hermes-slash-commands";
import type { ImageAttachment } from "../lib/images";
import { useComposerDraftsStore } from "../stores/composer-drafts";
import {
  cancelSharedAttachment,
  uploadSharedAttachment,
} from "../lib/shared-attachments";

vi.mock("../lib/shared-attachments", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../lib/shared-attachments")>();
  return {
    ...original,
    uploadSharedAttachment: vi.fn(),
    cancelSharedAttachment: vi.fn(() => Promise.resolve()),
  };
});

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:verified-attachment"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(async () => {
  // Let acknowledgement-aware sends from the just-finished test settle before
  // resetting the shared draft store. Otherwise a late success can observe a
  // recycled revision in the next test and clear that test's draft.
  await act(async () => {
    await Promise.resolve();
  });
  vi.clearAllMocks();
  useComposerDraftsStore.setState({
    drafts: {},
    revisions: {},
    imageDrafts: {},
    attachmentDrafts: {},
    sendingAttachments: {},
  });
});

const COMMANDS: HermesSlashCommand[] = [
  { command: "/help", description: "Show available commands" },
  { command: "/new", description: "Start a new session", argsHint: "[name]", aliases: ["/reset"] },
  { command: "/queue", description: "Queue a prompt", argsHint: "<prompt>" },
];

function renderInputBar(overrides: Partial<Parameters<typeof InputBar>[0]> = {}) {
  const onSend = vi.fn(() => true);
  const utils = render(
    <InputBar
      convId="conv-1"
      draftKey="conversation:conv-1"
      onSend={onSend}
      onStop={() => {}}
      slashCommands={COMMANDS}
      {...overrides}
    />,
  );
  const editor = utils.container.querySelector<HTMLElement>(".ProseMirror");
  if (!editor) throw new Error("ProseMirror editor not found");
  return { ...utils, onSend, editor };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function openMenu(editor: HTMLElement) {
  fireEvent.keyDown(editor, { key: "/" });
  return screen.getByTestId("slash-command-menu");
}

describe("InputBar slash command menu", () => {
  it("does not render a slash command button", () => {
    renderInputBar();
    expect(screen.queryByTitle("Bot commands")).toBeNull();
  });

  it("opens a menu listing all commands when typing slash", () => {
    const { editor } = renderInputBar();
    openMenu(editor);
    expect(screen.getByTestId("slash-command-item-help")).toBeInTheDocument();
    expect(screen.getByTestId("slash-command-item-new")).toBeInTheDocument();
    expect(screen.getByTestId("slash-command-item-queue")).toBeInTheDocument();
    expect(screen.getByText("Show available commands")).toBeInTheDocument();
    expect(screen.getByText("<prompt>")).toBeInTheDocument();
  });

  it("navigates with arrow keys and highlights the selection", () => {
    const { editor } = renderInputBar();
    openMenu(editor);

    expect(screen.getByTestId("slash-command-item-help").dataset.selected).toBe("true");

    fireEvent.keyDown(editor, { key: "ArrowDown" });
    expect(screen.getByTestId("slash-command-item-help").dataset.selected).toBeUndefined();
    expect(screen.getByTestId("slash-command-item-new").dataset.selected).toBe("true");

    fireEvent.keyDown(editor, { key: "ArrowUp" });
    fireEvent.keyDown(editor, { key: "ArrowUp" });
    expect(screen.getByTestId("slash-command-item-queue").dataset.selected).toBe("true");
  });

  it("sends argument-less commands immediately on Enter", async () => {
    const { editor, onSend } = renderInputBar();
    openMenu(editor);

    await act(async () => fireEvent.keyDown(editor, { key: "Enter" }));
    expect(onSend).toHaveBeenCalledWith("/help");
    await waitFor(() => {
      expect(screen.queryByTestId("slash-command-menu")).toBeNull();
      expect(editor.textContent ?? "").toBe("");
    });
  });

  it("inserts commands that require arguments instead of sending", () => {
    const { editor, onSend } = renderInputBar();
    openMenu(editor);

    fireEvent.keyDown(editor, { key: "ArrowDown" });
    fireEvent.keyDown(editor, { key: "ArrowDown" });
    fireEvent.keyDown(editor, { key: "Enter" });

    expect(onSend).not.toHaveBeenCalled();
    expect(editor.textContent).toBe("/queue ");
    // Menu closes once arguments are being typed.
    expect(screen.queryByTestId("slash-command-menu")).toBeNull();
  });

  it("inserts the highlighted command on Tab without sending", () => {
    const { editor, onSend } = renderInputBar();
    openMenu(editor);

    fireEvent.keyDown(editor, { key: "Tab" });
    expect(onSend).not.toHaveBeenCalled();
    expect(editor.textContent).toBe("/help ");
  });

  it("dismisses the menu on Escape", () => {
    const { editor } = renderInputBar();
    openMenu(editor);

    fireEvent.keyDown(editor, { key: "Escape" });
    expect(screen.queryByTestId("slash-command-menu")).toBeNull();
  });

  it("selects a command on click", async () => {
    const { editor, onSend } = renderInputBar();
    openMenu(editor);

    await act(async () =>
      fireEvent.mouseDown(screen.getByTestId("slash-command-item-help")),
    );
    expect(onSend).toHaveBeenCalledWith("/help");
  });

  it("keeps action controls in normal layout below the editor", () => {
    const { editor } = renderInputBar();
    expect(screen.getByTestId("input-actions")).not.toHaveClass("absolute");
    expect(editor.className).not.toContain("pb-11");
  });

  it("clears real composer text immediately and restores the exact rejected draft", async () => {
    let rejectFirst!: (accepted: boolean) => void;
    const onSend = vi
      .fn(
        (
          _content: string,
          _images?: ImageAttachment[],
        ): boolean | Promise<boolean> => true,
      )
      .mockReturnValueOnce(
        new Promise<boolean>((resolve) => {
          rejectFirst = resolve;
        }),
      )
      .mockResolvedValueOnce(true);
    const { container, editor } = renderInputBar({
      onSend,
      optimisticSend: true,
    });
    const fileInput = container.querySelector<HTMLInputElement>("input[type='file']");
    if (!fileInput) throw new Error("File input not found");

    openMenu(editor);
    fireEvent.keyDown(editor, { key: "ArrowDown" });
    fireEvent.keyDown(editor, { key: "ArrowDown" });
    fireEvent.keyDown(editor, { key: "Tab" });
    expect(editor.textContent).toBe("/queue ");
    fireEvent.change(fileInput, {
      target: {
        files: [new File(["image"], "retry.png", { type: "image/png" })],
      },
    });
    await waitFor(() =>
      expect(container.querySelector("img[src^='data:image/png;base64,']")).not.toBeNull(),
    );

    fireEvent.click(screen.getByTitle("Send message"));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0][0]).toBe("/queue");
    expect(onSend.mock.calls[0][1]).toHaveLength(1);
    expect(editor.textContent).toBe("");
    expect(container.querySelector("img[src^='data:image/png;base64,']")).not.toBeNull();

    await act(async () => rejectFirst(false));
    await waitFor(() => expect(editor.textContent).toBe("/queue "));
    expect(container.querySelector("img[src^='data:image/png;base64,']")).not.toBeNull();

    fireEvent.click(screen.getByTitle("Send message"));
    await waitFor(() => expect(editor.textContent).toBe(""));
    expect(container.querySelector("img[src^='data:image/png;base64,']")).toBeNull();
    expect(onSend).toHaveBeenCalledTimes(2);
  });
});

describe("InputBar shared attachments", () => {
  const attachment = {
    id: "attachment-1",
    fileName: "report.txt",
    name: "report.txt",
    mediaType: "text/plain",
    mimeType: "text/plain",
    sizeBytes: 6,
    kind: "file" as const,
    status: "ready" as const,
    contentPath: "/attachments/attachment-1/content",
  };

  function makeUploadReady() {
    vi.mocked(uploadSharedAttachment).mockImplementation(
      async (_input, update) => {
        update({ phase: "ready", progress: 100, attachment });
        return attachment;
      },
    );
  }

  it("leaves the shared file chooser unrestricted by MIME type", () => {
    const { container } = renderInputBar({
      sharedUpload: { conversationId: "conversation-1", token: "token-1" },
    });
    const fileInput = container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    expect(fileInput).not.toBeNull();
    expect(fileInput).not.toHaveAttribute("accept");
  });

  it("uploads a file when the browser provides no MIME type", async () => {
    makeUploadReady();
    const { container } = renderInputBar({
      sharedUpload: { conversationId: "conversation-1", token: "token-1" },
    });
    const fileInput = container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    if (!fileInput) throw new Error("File input not found");
    const file = new File(["raw email"], "message.eml");

    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => expect(uploadSharedAttachment).toHaveBeenCalledOnce());
    expect(vi.mocked(uploadSharedAttachment).mock.calls[0]?.[0].file).toBe(file);
    expect(screen.getByText("message.eml")).toBeInTheDocument();
  });

  it("previews an image only after the server classifies it as a raster", async () => {
    vi.mocked(uploadSharedAttachment).mockImplementation(
      async (_input, onUpdate) => {
        const pending = {
          id: "attachment-image",
          name: "preview.bin",
          fileName: "preview.bin",
          mediaType: "application/octet-stream",
          mimeType: "application/octet-stream",
          sizeBytes: 4,
          kind: "file" as const,
          width: null,
          height: null,
          status: "processing" as const,
          contentPath: "/attachments/attachment-image/content",
          downloadPath: "/attachments/attachment-image/download",
        };
        onUpdate({ phase: "uploading", progress: 100, attachment: pending });
        expect(URL.createObjectURL).not.toHaveBeenCalled();
        const ready = {
          ...pending,
          mediaType: "image/png",
          mimeType: "image/png",
          kind: "image" as const,
          width: 1,
          height: 1,
          status: "ready" as const,
        };
        onUpdate({ phase: "ready", progress: 100, attachment: ready });
        return ready;
      },
    );
    const { container } = renderInputBar({
      sharedUpload: { conversationId: "conversation-1", token: "token-1" },
    });
    const fileInput = container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    if (!fileInput) throw new Error("File input not found");
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "preview.bin", {
      type: "application/octet-stream",
    });

    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledOnce());
    const previewBlob = vi.mocked(URL.createObjectURL).mock.calls[0]?.[0];
    if (!(previewBlob instanceof Blob)) {
      throw new Error("Expected a Blob preview");
    }
    expect(previewBlob.type).toBe("image/png");
    const preview = screen.getByTestId("attachment-draft").querySelector("img");
    expect(preview).toHaveAttribute("src", "blob:verified-attachment");
  });

  it("sends an attachment-only message and keeps the draft until send succeeds", async () => {
    makeUploadReady();
    let resolveSend!: (value: boolean) => void;
    const sendResult = new Promise<boolean>((resolve) => {
      resolveSend = resolve;
    });
    const onSend = vi.fn(() => sendResult);
    const { container } = renderInputBar({
      onSend,
      sharedUpload: { conversationId: "conversation-1", token: "token-1" },
    });
    const fileInput = container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    if (!fileInput) throw new Error("File input not found");

    fireEvent.change(fileInput, {
      target: {
        files: [new File(["report"], "report.txt", { type: "text/plain" })],
      },
    });
    await waitFor(() => expect(screen.getByText(/Ready/)).toBeInTheDocument());
    const draft = screen.getByTestId("attachment-draft");
    expect(draft).toHaveAttribute("data-attachment-file-name", "report.txt");
    expect(draft).toHaveAttribute("data-attachment-phase", "ready");
    expect(draft).toHaveAttribute("data-attachment-progress", "100");
    expect(draft).toHaveAttribute("data-attachment-id", "attachment-1");

    fireEvent.click(screen.getByTitle("Send message"));
    expect(onSend).toHaveBeenCalledWith("", undefined, ["attachment-1"]);
    expect(screen.getByText("report.txt")).toBeInTheDocument();

    await act(async () => resolveSend(true));
    await waitFor(() => expect(screen.queryByText("report.txt")).toBeNull());
  });

  it("restores a ready attachment when switching away from and back to a thread", async () => {
    makeUploadReady();
    const onSend = vi.fn();
    const onStop = vi.fn();
    const sharedUpload = {
      conversationId: "conversation-1",
      token: "token-1",
    };
    const { container, rerender } = renderInputBar({
      draftKey: "dm:conversation-1:thread:task-1",
      onSend,
      onStop,
      sharedUpload,
    });
    const fileInput = container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    if (!fileInput) throw new Error("File input not found");

    fireEvent.change(fileInput, {
      target: {
        files: [new File(["report"], "report.txt", { type: "text/plain" })],
      },
    });
    await waitFor(() => expect(screen.getByText(/Ready/)).toBeInTheDocument());

    rerender(
      <InputBar
        convId="conversation-1"
        draftKey="dm:conversation-1:thread:task-2"
        onSend={onSend}
        onStop={onStop}
        slashCommands={COMMANDS}
        sharedUpload={sharedUpload}
      />,
    );
    expect(screen.queryByText("report.txt")).toBeNull();
    expect(cancelSharedAttachment).not.toHaveBeenCalled();

    rerender(
      <InputBar
        convId="conversation-1"
        draftKey="dm:conversation-1:thread:task-1"
        onSend={onSend}
        onStop={onStop}
        slashCommands={COMMANDS}
        sharedUpload={sharedUpload}
      />,
    );
    expect(screen.getByText("report.txt")).toBeInTheDocument();
    expect(screen.getByTestId("attachment-draft")).toHaveAttribute(
      "data-attachment-phase",
      "ready",
    );
    expect(cancelSharedAttachment).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove report.txt" }));
    await waitFor(() =>
      expect(cancelSharedAttachment).toHaveBeenCalledWith(
        "attachment-1",
        "token-1",
      ),
    );
    expect(cancelSharedAttachment).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText("report.txt")).toBeNull());
  });

  it("continues an upload while its thread is inactive and restores the result", async () => {
    const upload = deferred<typeof attachment>();
    let updateUpload!: Parameters<typeof uploadSharedAttachment>[1];
    let uploadSignal!: AbortSignal;
    vi.mocked(uploadSharedAttachment).mockImplementation((input, update) => {
      updateUpload = update;
      uploadSignal = input.signal;
      update({ phase: "uploading", progress: 25, attachment });
      return upload.promise;
    });
    const sharedUpload = {
      conversationId: "conversation-1",
      token: "token-1",
    };
    const { container, rerender } = renderInputBar({
      draftKey: "dm:conversation-1:thread:task-1",
      sharedUpload,
    });
    const fileInput = container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    if (!fileInput) throw new Error("File input not found");

    fireEvent.change(fileInput, {
      target: {
        files: [new File(["report"], "report.txt", { type: "text/plain" })],
      },
    });
    await waitFor(() => expect(screen.getByText(/Uploading/)).toBeInTheDocument());

    rerender(
      <InputBar
        convId="conversation-1"
        draftKey="dm:conversation-1:thread:task-2"
        onSend={() => undefined}
        onStop={() => undefined}
        slashCommands={COMMANDS}
        sharedUpload={sharedUpload}
      />,
    );
    expect(uploadSignal.aborted).toBe(false);
    expect(screen.queryByText("report.txt")).toBeNull();

    await act(async () => {
      updateUpload({ phase: "ready", progress: 100, attachment });
      upload.resolve(attachment);
      await upload.promise;
    });
    rerender(
      <InputBar
        convId="conversation-1"
        draftKey="dm:conversation-1:thread:task-1"
        onSend={() => undefined}
        onStop={() => undefined}
        slashCommands={COMMANDS}
        sharedUpload={sharedUpload}
      />,
    );

    await waitFor(() => expect(screen.getByText(/Ready/)).toBeInTheDocument());
    expect(screen.getByText("report.txt")).toBeInTheDocument();
    expect(cancelSharedAttachment).not.toHaveBeenCalled();
  });

  it("cancels a ready draft when the user removes it", async () => {
    makeUploadReady();
    const { container } = renderInputBar({
      sharedUpload: { conversationId: "conversation-1", token: "token-1" },
    });
    const fileInput = container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    if (!fileInput) throw new Error("File input not found");

    fireEvent.change(fileInput, {
      target: {
        files: [new File(["report"], "report.txt", { type: "text/plain" })],
      },
    });
    await waitFor(() => expect(screen.getByText(/Ready/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Remove report.txt" }));

    await waitFor(() =>
      expect(cancelSharedAttachment).toHaveBeenCalledWith(
        "attachment-1",
        "token-1",
      ),
    );
    await waitFor(() => expect(screen.queryByText("report.txt")).toBeNull());
  });

  it("keeps the draft visible when cancellation fails", async () => {
    makeUploadReady();
    vi.mocked(cancelSharedAttachment).mockRejectedValueOnce(
      new Error("Cancellation service unavailable"),
    );
    const { container } = renderInputBar({
      sharedUpload: { conversationId: "conversation-1", token: "token-1" },
    });
    const fileInput = container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    if (!fileInput) throw new Error("File input not found");

    fireEvent.change(fileInput, {
      target: {
        files: [new File(["report"], "report.txt", { type: "text/plain" })],
      },
    });
    await waitFor(() => expect(screen.getByText(/Ready/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Remove report.txt" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Cancellation service unavailable",
      ),
    );
    expect(screen.getByText("report.txt")).toBeInTheDocument();
    expect(screen.getByTestId("attachment-draft")).toHaveAttribute(
      "data-attachment-phase",
      "error",
    );
  });

  it("keeps a ready draft owned by its scope when the input unmounts", async () => {
    makeUploadReady();
    const { container, unmount } = renderInputBar({
      sharedUpload: { conversationId: "conversation-1", token: "token-1" },
    });
    const fileInput = container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    if (!fileInput) throw new Error("File input not found");

    fireEvent.change(fileInput, {
      target: {
        files: [new File(["report"], "report.txt", { type: "text/plain" })],
      },
    });
    await waitFor(() => expect(screen.getByText(/Ready/)).toBeInTheDocument());

    unmount();
    expect(cancelSharedAttachment).not.toHaveBeenCalled();
    expect(
      useComposerDraftsStore.getState().attachmentDrafts[
        "conversation:conv-1"
      ]?.[0]?.attachment?.id,
    ).toBe("attachment-1");
  });

  it("does not cancel an in-flight attachment when the composer scope changes", async () => {
    makeUploadReady();
    const send = deferred<boolean>();
    const onSend = vi.fn(() => send.promise);
    const { container, rerender } = renderInputBar({
      draftKey: "dm:conversation-1:thread:task-1",
      onSend,
      sharedUpload: { conversationId: "conversation-1", token: "token-1" },
    });
    const fileInput = container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    if (!fileInput) throw new Error("File input not found");

    fireEvent.change(fileInput, {
      target: {
        files: [new File(["report"], "report.txt", { type: "text/plain" })],
      },
    });
    await waitFor(() => expect(screen.getByText(/Ready/)).toBeInTheDocument());
    fireEvent.click(screen.getByTitle("Send message"));

    rerender(
      <InputBar
        convId="conversation-2"
        draftKey="dm:conversation-2:thread:task-2"
        onSend={onSend}
        onStop={() => undefined}
        slashCommands={COMMANDS}
        sharedUpload={{ conversationId: "conversation-2", token: "token-2" }}
      />,
    );
    expect(cancelSharedAttachment).not.toHaveBeenCalled();

    rerender(
      <InputBar
        convId="conversation-1"
        draftKey="dm:conversation-1:thread:task-1"
        onSend={onSend}
        onStop={() => undefined}
        slashCommands={COMMANDS}
        sharedUpload={{ conversationId: "conversation-1", token: "token-1" }}
      />,
    );
    expect(screen.getByText("report.txt")).toBeInTheDocument();
    expect(screen.getByTitle("Send message")).toBeDisabled();
    expect(screen.getByTitle("Attach files")).toBeDisabled();

    await act(async () => {
      send.resolve(true);
      await send.promise;
    });
    await waitFor(() => expect(screen.queryByText("report.txt")).toBeNull());
    expect(cancelSharedAttachment).not.toHaveBeenCalled();
  });

  it("restores an in-flight attachment when its send fails after a scope change", async () => {
    makeUploadReady();
    const send = deferred<boolean>();
    const onSend = vi.fn(() => send.promise);
    const { container, rerender } = renderInputBar({
      draftKey: "dm:conversation-1:thread:task-1",
      onSend,
      sharedUpload: { conversationId: "conversation-1", token: "token-1" },
    });
    const fileInput = container.querySelector<HTMLInputElement>(
      'input[type="file"]',
    );
    if (!fileInput) throw new Error("File input not found");

    fireEvent.change(fileInput, {
      target: {
        files: [new File(["report"], "report.txt", { type: "text/plain" })],
      },
    });
    await waitFor(() => expect(screen.getByText(/Ready/)).toBeInTheDocument());
    fireEvent.click(screen.getByTitle("Send message"));
    rerender(
      <InputBar
        convId="conversation-2"
        draftKey="dm:conversation-2:thread:task-2"
        onSend={onSend}
        onStop={() => undefined}
        slashCommands={COMMANDS}
        sharedUpload={{ conversationId: "conversation-2", token: "token-2" }}
      />,
    );
    expect(cancelSharedAttachment).not.toHaveBeenCalled();

    await act(async () => {
      send.resolve(false);
      await send.promise;
    });
    expect(cancelSharedAttachment).not.toHaveBeenCalled();

    rerender(
      <InputBar
        convId="conversation-1"
        draftKey="dm:conversation-1:thread:task-1"
        onSend={onSend}
        onStop={() => undefined}
        slashCommands={COMMANDS}
        sharedUpload={{ conversationId: "conversation-1", token: "token-1" }}
      />,
    );
    expect(screen.getByText("report.txt")).toBeInTheDocument();
    expect(screen.getByTestId("attachment-draft")).toHaveAttribute(
      "data-attachment-phase",
      "ready",
    );
  });
});
