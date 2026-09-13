import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { InputBar } from "./InputBar";
import { resetPrivateSession } from "../lib/session-boundary";
import { useComposerDraftsStore } from "../stores/composer-drafts";
import { cancelSharedAttachment, uploadSharedAttachment } from "../lib/shared-attachments";

vi.mock("../lib/shared-attachments", async (original) => ({
  ...await original<typeof import("../lib/shared-attachments")>(),
  uploadSharedAttachment: vi.fn(),
  cancelSharedAttachment: vi.fn(async () => {}),
}));
class Recorder {
  static isTypeSupported = (type: string) => type === "audio/webm;codecs=opus";
  static current: Recorder;
  mimeType = "audio/webm;codecs=opus";
  state = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { Recorder.current = this; }
  start() { this.state = "recording"; }
  stop() { this.state = "inactive"; }
  finish() {
    this.ondataavailable?.({ data: new Blob(["voice"], { type: this.mimeType }) });
    return this.onstop?.();
  }
}
const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
const stream = { getTracks: () => tracks } as unknown as MediaStream;
const getUserMedia = vi.fn();
const props = { convId: "chat", draftKey: "chat", onSend: vi.fn(async () => true), onStop: vi.fn(), sharedUpload: { conversationId: "chat", token: "token-a" } };

beforeEach(() => {
  vi.clearAllMocks();
  useComposerDraftsStore.setState({ drafts: { chat: "Keep this draft" }, revisions: {}, imageDrafts: {}, attachmentDrafts: {}, sendingAttachments: {} });
  vi.stubGlobal("MediaRecorder", Recorder);
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  getUserMedia.mockResolvedValue(stream);
  Element.prototype.scrollIntoView = vi.fn();
  URL.createObjectURL = vi.fn(() => "blob:voice-preview");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.mocked(uploadSharedAttachment).mockImplementation(async ({ file }, update) => {
    const attachment = { id: "voice-id", fileName: file.name, name: file.name, mediaType: file.type, mimeType: file.type, sizeBytes: file.size, kind: "file" as const, width: null, height: null, status: "ready" as const, contentPath: "/attachments/voice-id/content" };
    update({ phase: "ready", progress: 100, attachment });
    return attachment;
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function recordPreview() {
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Record voice message" })));
  fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
  await act(async () => { await Recorder.current.finish(); });
}

it.each(["discard", "draft", "token", "session", "unmount"])("aborts upload on %s and never sends a stale completion", async (change) => {
  let finish!: (value: Awaited<ReturnType<typeof uploadSharedAttachment>>) => void;
  const originalUpload = vi.mocked(uploadSharedAttachment).getMockImplementation()!;
  vi.mocked(uploadSharedAttachment).mockImplementationOnce((input, update) => new Promise(resolve => {
    finish = resolve;
    void originalUpload(input, update);
  }));
  const view = render(<InputBar {...props} />);
  await recordPreview();
  fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));
  const signal = vi.mocked(uploadSharedAttachment).mock.calls[0][0].signal;
  if (change === "discard") fireEvent.click(screen.getByRole("button", { name: "Discard recording" }));
  if (change === "draft") view.rerender(<InputBar {...props} draftKey="other" />);
  if (change === "token") view.rerender(<InputBar {...props} sharedUpload={{ conversationId: "chat", token: "other" }} />);
  if (change === "session") act(() => resetPrivateSession());
  if (change === "unmount") view.unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => finish({ id: "late-voice" } as Awaited<ReturnType<typeof uploadSharedAttachment>>));
  expect(props.onSend).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("Voice message preview")).toBeNull();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:voice-preview");
});

it.each([true, false])("does not cancel an in-flight message reservation on navigation (accepted=%s)", async (accepted) => {
  let finish!: (value: boolean) => void;
  const onSend = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
  const view = render(<InputBar {...props} onSend={onSend} />);
  await recordPreview();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send voice message" })));
  expect(onSend).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Discard recording" })).toBeDisabled();
  view.rerender(<InputBar {...props} draftKey="other" />);
  expect(cancelSharedAttachment).not.toHaveBeenCalled();
  await act(async () => finish(accepted));
  if (accepted) expect(cancelSharedAttachment).not.toHaveBeenCalled();
  else expect(cancelSharedAttachment).toHaveBeenCalledExactlyOnceWith("voice-id", "token-a");
});

it("cleans a failed upload reservation before retrying the retained local recording", async () => {
  vi.mocked(uploadSharedAttachment).mockImplementationOnce(async (_input, update) => {
    update({ phase: "uploading", progress: 21, attachment: { id: "failed-upload" } as Awaited<ReturnType<typeof uploadSharedAttachment>> });
    throw new Error("Connection lost");
  });
  render(<InputBar {...props} />);
  await recordPreview();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send voice message" })));
  expect(screen.getByRole("alert")).toHaveTextContent("Connection lost");
  expect(props.onSend).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Voice message preview")).toBeInTheDocument();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: /(?:Send|Retry) voice message/ })));
  expect(cancelSharedAttachment).toHaveBeenCalledExactlyOnceWith("failed-upload", "token-a");
  expect(vi.mocked(cancelSharedAttachment).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(uploadSharedAttachment).mock.invocationCallOrder[1]);
  expect(uploadSharedAttachment).toHaveBeenCalledTimes(2);
  expect(props.onSend).toHaveBeenCalledExactlyOnceWith("", undefined, ["voice-id"]);
});

it("coalesces simultaneous Send gestures before React renders busy state", async () => {
  vi.mocked(uploadSharedAttachment).mockReturnValue(new Promise(() => {}));
  render(<InputBar {...props} />);
  await recordPreview();
  const send = screen.getByRole("button", { name: "Send voice message" });
  act(() => { send.click(); send.click(); });
  expect(uploadSharedAttachment).toHaveBeenCalledOnce();
});

it("can record and send in a new cookie session without reusing the old capability", async () => {
  const onSend = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  render(<InputBar {...props} onSend={onSend} sharedUpload={{ conversationId: "chat", token: null }} />);
  await recordPreview();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send voice message" })));
  act(() => resetPrivateSession());
  expect(cancelSharedAttachment).not.toHaveBeenCalled();
  await recordPreview();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send voice message" })));
  expect(uploadSharedAttachment).toHaveBeenCalledTimes(2);
  expect(onSend).toHaveBeenCalledTimes(2);
  expect(screen.queryByLabelText("Voice message preview")).toBeNull();
});

it("replaces the composer with an integrated review player while keeping its editor mounted", async () => {
  const { container } = render(<InputBar {...props} />);
  const editor = screen.getByRole("textbox", { name: "Message" });
  await recordPreview();
  expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
  expect(container.querySelector(".ProseMirror")).toBe(editor);
  expect(screen.getByRole("button", { name: "Play voice message preview" })).toBeInTheDocument();
  expect(screen.getByLabelText("Voice message preview")).not.toHaveAttribute("controls");
  expect(screen.queryByRole("button", { name: "Attach files" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Discard recording" }));
  expect(screen.getByRole("textbox", { name: "Message" })).toBe(editor);
  expect(editor.textContent).toBe("Keep this draft");
});

it("blocks optimistic editor submission before it can clear the rich draft during capture", async () => {
  const { container } = render(<InputBar {...props} optimisticSend />);
  const editor = container.querySelector(".ProseMirror")!;
  await recordPreview();
  act(() => { fireEvent.keyDown(editor, { key: "Enter" }); });
  expect(editor.textContent).toBe("Keep this draft");
  expect(useComposerDraftsStore.getState().drafts.chat).toBe("Keep this draft");
  expect(props.onSend).not.toHaveBeenCalled();
});

it("pauses review and shows real transfer progress after explicit Send", async () => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.mocked(uploadSharedAttachment).mockImplementationOnce((_input, update) => {
    update({ phase: "uploading", progress: 37 });
    return new Promise(() => {});
  });
  render(<InputBar {...props} />);
  await recordPreview();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Play voice message preview" })));
  const before = vi.mocked(HTMLMediaElement.prototype.pause).mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "Send voice message" }));
  expect(vi.mocked(HTMLMediaElement.prototype.pause).mock.calls.length).toBeGreaterThan(before);
  expect(screen.getByRole("button", { name: "Play voice message preview" })).toBeDisabled();
  expect(screen.getByRole("progressbar", { name: "Uploading voice message" })).toHaveAttribute("value", "37");
  expect(screen.getByRole("button", { name: "Discard recording" })).toBeEnabled();
});

it("cancels recording when the composer becomes unavailable", async () => {
  render(<InputBar {...props} />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Record voice message" })));
  act(() => useComposerDraftsStore.setState({ sendingAttachments: { chat: true } }));
  for (const track of tracks) expect(track.stop).toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Stop recording" })).toBeNull();
  expect(uploadSharedAttachment).not.toHaveBeenCalled();
});

it.each(["changed", "removed"])("does not retain a staged recording after auth is %s", async (change) => {
  const view = render(<InputBar {...props} onSend={async () => false} />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Record voice message" })));
  fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
  await act(async () => { await Recorder.current.finish(); });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send voice message" })));
  expect(screen.getByLabelText("Voice message preview")).toBeInTheDocument();
  view.rerender(<InputBar {...props} sharedUpload={change === "removed" ? undefined : { conversationId: "chat", token: "other" }} />);
  expect(screen.queryByLabelText("Voice message preview")).toBeNull();
  expect(cancelSharedAttachment).toHaveBeenCalledWith("voice-id", "token-a");
});

it("stops preview playback and revokes its URL on an auth scope change", async () => {
  const view = render(<InputBar {...props} />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Record voice message" })));
  fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
  await act(async () => { await Recorder.current.finish(); });
  expect(screen.getByLabelText("Voice message preview")).toBeInTheDocument();
  view.rerender(<InputBar {...props} sharedUpload={{ conversationId: "chat", token: "other" }} />);
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:voice-preview");
  expect(screen.queryByLabelText("Voice message preview")).toBeNull();
  expect(uploadSharedAttachment).not.toHaveBeenCalled();
});

it.each(["idle", "recording", "preview"])("a full unrelated attachment draft does not disable voice in %s", async (phase) => {
  const drafts = Array.from({ length: 10 }, (_, i) => ({ localId: String(i), file: new File(["x"], `file-${i}`), previewUrl: null, phase: "queued" as const, progress: 0, attachment: null, error: null }));
  useComposerDraftsStore.setState({ attachmentDrafts: { chat: phase === "idle" ? drafts : drafts.slice(0, 9) } });
  render(<InputBar {...props} />);
  const button = screen.getByRole("button", { name: "Record voice message" });
  expect(button).toBeEnabled();
  await act(async () => fireEvent.click(button));
  if (phase === "preview") {
    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    await act(async () => { await Recorder.current.finish(); });
  }
  const stopCalls = tracks.map(track => track.stop.mock.calls.length);
  if (phase !== "idle") act(() => useComposerDraftsStore.setState({ attachmentDrafts: { chat: drafts } }));
  expect(screen.getByRole("button", { name: phase === "preview" ? "Send voice message" : "Stop recording" })).toBeEnabled();
  expect(tracks.map(track => track.stop.mock.calls.length)).toEqual(stopCalls);
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
});

it.each(["sending", "local"])("does not request a microphone when %s", async (reason) => {
  if (reason === "sending") useComposerDraftsStore.setState({ sendingAttachments: { chat: true } });
  render(<InputBar {...props} sharedUpload={reason === "local" ? undefined : props.sharedUpload} />);
  const button = screen.queryByRole("button", { name: "Record voice message" });
  if (reason === "local") expect(button).toBeNull();
  else { expect(button).toBeDisabled(); fireEvent.click(button!); }
  expect(getUserMedia).not.toHaveBeenCalled();
});

it.each(["token", "conversation", "draft", "unmount"])("cancels pending microphone permission on %s change", async (change) => {
  let resolve!: (value: MediaStream) => void;
  getUserMedia.mockReturnValue(new Promise<MediaStream>((done) => { resolve = done; }));
  const view = render(<InputBar {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Record voice message" }));
  if (change === "unmount") view.unmount();
  else view.rerender(<InputBar {...props}
    draftKey={change === "draft" ? "other" : props.draftKey}
    sharedUpload={{ conversationId: change === "conversation" ? "other" : "chat", token: change === "token" ? "token-b" : "token-a" }} />);
  await act(async () => resolve(stream));
  for (const track of tracks) expect(track.stop).toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Stop recording" })).toBeNull();
  expect(uploadSharedAttachment).not.toHaveBeenCalled();
});

it("blocks button and keyboard sends until a recording is attached or discarded", async () => {
  let resolve!: (value: MediaStream) => void;
  getUserMedia.mockReturnValue(new Promise<MediaStream>((done) => { resolve = done; }));
  const { container } = render(<InputBar {...props} />);
  const editor = container.querySelector(".ProseMirror")!;
  fireEvent.click(screen.getByRole("button", { name: "Record voice message" }));
  for (const phase of ["requesting", "recording", "stopping", "preview"]) {
    expect(screen.getByTitle("Send message"), phase).toBeDisabled();
    await act(async () => { fireEvent.keyDown(editor, { key: "Enter" }); });
    expect(props.onSend).not.toHaveBeenCalled();
    if (phase === "requesting") await act(async () => resolve(stream));
    if (phase === "recording") fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    if (phase === "stopping") await act(async () => { await Recorder.current.finish(); });
  }
  fireEvent.click(screen.getByRole("button", { name: "Discard recording" }));
  expect(screen.getByTitle("Send message")).not.toBeDisabled();
  expect(uploadSharedAttachment).not.toHaveBeenCalled();
});

it("sends a local voice preview directly without Attach or consuming the typed draft", async () => {
  const onSend = vi.fn().mockResolvedValue(true);
  const { container } = render(<InputBar {...props} onSend={onSend} />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Record voice message" })));
  fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
  await act(async () => { await Recorder.current.finish(); });
  expect(uploadSharedAttachment).not.toHaveBeenCalled();
  expect(onSend).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Attach recording" })).toBeNull();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send voice message" })));
  expect(uploadSharedAttachment).toHaveBeenCalledOnce();
  expect(onSend).toHaveBeenCalledExactlyOnceWith("", undefined, ["voice-id"]);
  expect(screen.queryByTestId("attachment-draft")).toBeNull();
  expect(screen.queryByLabelText("Voice message preview")).toBeNull();
  expect(container.querySelector(".ProseMirror")?.textContent).toBe("Keep this draft");
  expect(useComposerDraftsStore.getState().drafts.chat).toBe("Keep this draft");
});

it.each([false, null])("retries a rejected voice send (%s) without uploading twice or consuming the draft", async (rejected) => {
  const onSend = vi.fn().mockResolvedValueOnce(rejected).mockResolvedValueOnce(true);
  const { container } = render(<InputBar {...props} onSend={onSend} />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Record voice message" })));
  fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
  await act(async () => { await Recorder.current.finish(); });
  const preview = screen.getByLabelText("Voice message preview") as HTMLAudioElement;
  expect(preview.autoplay).toBe(false);
  expect(preview.preload).toBe("none");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send voice message" })));
  expect(screen.getByRole("alert")).toHaveTextContent(/not sent/i);
  expect(screen.getByLabelText("Voice message preview")).toBeInTheDocument();
  expect(screen.queryByTestId("attachment-draft")).toBeNull();
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: /(?:Send|Retry) voice message/ })));
  expect(uploadSharedAttachment).toHaveBeenCalledOnce();
  expect(onSend).toHaveBeenCalledTimes(2);
  expect(onSend).toHaveBeenLastCalledWith("", undefined, ["voice-id"]);
  expect(container.querySelector(".ProseMirror")?.textContent).toBe("Keep this draft");
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:voice-preview");
  await waitFor(() => expect(screen.queryByLabelText("Voice message preview")).toBeNull());
});


it.each(["requesting", "recording", "preview"])("releases voice capture in %s phase when a cookie session resets", async (phase) => {
  let resolve!: (value: MediaStream) => void;
  if (phase === "requesting") getUserMedia.mockReturnValueOnce(new Promise<MediaStream>(done => { resolve = done; }));
  render(<InputBar {...props} sharedUpload={{ conversationId: "chat", token: null }} />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Record voice message" })));
  if (phase === "preview") {
    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    await act(async () => { await Recorder.current.finish(); });
    expect(screen.getByLabelText("Voice message preview")).toBeInTheDocument();
  }
  act(() => resetPrivateSession());
  if (phase === "requesting") await act(async () => resolve(stream));
  for (const track of tracks) expect(track.stop).toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Stop recording" })).toBeNull();
  expect(screen.queryByLabelText("Voice message preview")).toBeNull();
  if (phase === "preview") expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:voice-preview");
  expect(uploadSharedAttachment).not.toHaveBeenCalled();
});
