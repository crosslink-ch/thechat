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
});

afterEach(() => {
  vi.clearAllMocks();
});

const COMMANDS: HermesSlashCommand[] = [
  { command: "/help", description: "Show available commands" },
  { command: "/new", description: "Start a new session", argsHint: "[name]", aliases: ["/reset"] },
  { command: "/queue", description: "Queue a prompt", argsHint: "<prompt>" },
];

function renderInputBar(overrides: Partial<Parameters<typeof InputBar>[0]> = {}) {
  const onSend = vi.fn();
  const utils = render(
    <InputBar
      convId="conv-1"
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

  it("sends argument-less commands immediately on Enter", () => {
    const { editor, onSend } = renderInputBar();
    openMenu(editor);

    fireEvent.keyDown(editor, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("/help");
    expect(screen.queryByTestId("slash-command-menu")).toBeNull();
    expect(editor.textContent ?? "").toBe("");
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

  it("selects a command on click", () => {
    const { editor, onSend } = renderInputBar();
    openMenu(editor);

    fireEvent.mouseDown(screen.getByTestId("slash-command-item-help"));
    expect(onSend).toHaveBeenCalledWith("/help");
  });

  it("keeps action controls in normal layout below the editor", () => {
    const { editor } = renderInputBar();
    expect(screen.getByTestId("input-actions")).not.toHaveClass("absolute");
    expect(editor.className).not.toContain("pb-11");
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

    fireEvent.click(screen.getByTitle("Send message"));
    expect(onSend).toHaveBeenCalledWith("", undefined, ["attachment-1"]);
    expect(screen.getByText("report.txt")).toBeInTheDocument();

    await act(async () => resolveSend(true));
    await waitFor(() => expect(screen.queryByText("report.txt")).toBeNull());
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
    expect(screen.queryByText("report.txt")).toBeNull();
  });

  it("cancels a ready draft when the input unmounts", async () => {
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
    await waitFor(() =>
      expect(cancelSharedAttachment).toHaveBeenCalledWith(
        "attachment-1",
        "token-1",
      ),
    );
  });
});
