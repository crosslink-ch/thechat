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
    this.onstop?.();
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

it("cancels recording when the composer becomes unavailable", async () => {
  render(<InputBar {...props} />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Record voice message" })));
  act(() => useComposerDraftsStore.setState({ sendingAttachments: { chat: true } }));
  for (const track of tracks) expect(track.stop).toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Stop recording" })).toBeNull();
  expect(uploadSharedAttachment).not.toHaveBeenCalled();
});

it.each(["changed", "removed"])("does not retain a staged recording after auth is %s", async (change) => {
  const view = render(<InputBar {...props} />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Record voice message" })));
  fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
  act(() => Recorder.current.finish());
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Attach recording" })));
  expect(screen.getByTestId("attachment-draft")).toBeInTheDocument();
  view.rerender(<InputBar {...props} sharedUpload={change === "removed" ? undefined : { conversationId: "chat", token: "other" }} />);
  expect(screen.queryByTestId("attachment-draft")).toBeNull();
  expect(cancelSharedAttachment).toHaveBeenCalledWith("voice-id", "token-a");
});

it("stops preview playback and revokes its URL on an auth scope change", async () => {
  const view = render(<InputBar {...props} />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Record voice message" })));
  fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
  act(() => Recorder.current.finish());
  expect(screen.getByLabelText("Voice message preview")).toBeInTheDocument();
  view.rerender(<InputBar {...props} sharedUpload={{ conversationId: "chat", token: "other" }} />);
  expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:voice-preview");
  expect(screen.queryByLabelText("Voice message preview")).toBeNull();
  expect(uploadSharedAttachment).not.toHaveBeenCalled();
});

it.each(["sending", "limit", "local"])("does not request a microphone when %s", async (reason) => {
  if (reason === "sending") useComposerDraftsStore.setState({ sendingAttachments: { chat: true } });
  if (reason === "limit") useComposerDraftsStore.setState({ attachmentDrafts: { chat: Array.from({ length: 10 }, (_, i) => ({ localId: String(i), file: new File(["x"], `file-${i}`), previewUrl: null, phase: "queued", progress: 0, attachment: null, error: null })) } });
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
    if (phase === "stopping") act(() => Recorder.current.finish());
  }
  fireEvent.click(screen.getByRole("button", { name: "Discard recording" }));
  expect(screen.getByTitle("Send message")).not.toBeDisabled();
  expect(uploadSharedAttachment).not.toHaveBeenCalled();
});

it("previews a recording before uploading, then uses normal manual send with failed-send retry", async () => {
  const onSend = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const { container } = render(<InputBar {...props} onSend={onSend} />);
  expect(getUserMedia).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Record voice message" })));
  expect(screen.getByText(/Recording/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
  expect(screen.getByText(/Finishing recording/)).toBeInTheDocument();
  act(() => Recorder.current.finish());
  const preview = screen.getByLabelText("Voice message preview") as HTMLAudioElement;
  expect(preview.tagName).toBe("AUDIO");
  expect(preview.autoplay).toBe(false);
  expect(preview.preload).toBe("none");
  expect(uploadSharedAttachment).not.toHaveBeenCalled();
  expect(onSend).not.toHaveBeenCalled();
  expect(container.querySelector(".ProseMirror")?.textContent).toBe("Keep this draft");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Attach recording" })));
  expect(uploadSharedAttachment).toHaveBeenCalledOnce();
  expect(vi.mocked(uploadSharedAttachment).mock.calls[0][0]).toMatchObject({ conversationId: "chat", token: "token-a", file: { type: "audio/webm", name: "voice-message.webm" } });
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:voice-preview");
  expect(onSend).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByTitle("Send message")));
  expect(onSend).toHaveBeenLastCalledWith("Keep this draft", undefined, ["voice-id"]);
  expect(screen.getByTestId("attachment-draft")).toBeInTheDocument();
  expect(container.querySelector(".ProseMirror")?.textContent).toBe("Keep this draft");
  await act(async () => fireEvent.click(screen.getByTitle("Send message")));
  await waitFor(() => expect(screen.queryByTestId("attachment-draft")).toBeNull());
});


it.each(["requesting", "recording", "preview"])("releases voice capture in %s phase when a cookie session resets", async (phase) => {
  let resolve!: (value: MediaStream) => void;
  if (phase === "requesting") getUserMedia.mockReturnValueOnce(new Promise<MediaStream>(done => { resolve = done; }));
  render(<InputBar {...props} sharedUpload={{ conversationId: "chat", token: null }} />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Record voice message" })));
  if (phase === "preview") {
    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    act(() => Recorder.current.finish());
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
