import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VoiceRecording } from "./voice-recording";

class FakeRecorder extends EventTarget {
  static isTypeSupported = vi.fn((mime: string) => mime === "audio/webm;codecs=opus");
  static instances: FakeRecorder[] = [];
  mimeType: string;
  state = "inactive";
  start = vi.fn(() => { this.state = "recording"; });
  stop = vi.fn(() => { this.state = "inactive"; });
  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    super();
    this.mimeType = options?.mimeType ?? "audio/webm;codecs=opus";
    FakeRecorder.instances.push(this);
  }
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  chunk(bytes = "audio", type = this.mimeType) {
    this.ondataavailable?.({ data: new Blob([bytes], { type }) });
  }
  finish() { return this.onstop?.(); }
}
const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
const stream = { getTracks: () => tracks } as unknown as MediaStream;
const getUserMedia = vi.fn();
let voice: VoiceRecording;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.clearAllMocks();
  FakeRecorder.instances = [];
  FakeRecorder.isTypeSupported.mockImplementation((mime) => mime === "audio/webm;codecs=opus");
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  getUserMedia.mockResolvedValue(stream);
  voice = new VoiceRecording(vi.fn());
});
afterEach(() => { voice.cancel(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each(["NotSupportedError", "NotReadableError", "NotFoundError"])("turns %s into actionable microphone recovery instead of raw engine text", async (name) => {
  getUserMedia.mockRejectedValueOnce(new DOMException("Not supported", name));
  await voice.start();
  expect(voice.state.error).toMatch(/microphone/i);
  expect(voice.state.error).toMatch(/check|allow|connect|try/i);
  expect(voice.state.error).not.toBe("Not supported");
});

it("ignores duplicate start and stop gestures", async () => {
  const pending = voice.start();
  await voice.start(); await pending;
  expect(getUserMedia).toHaveBeenCalledOnce();
  const recorder = FakeRecorder.instances[0];
  recorder.chunk(); voice.stop(); voice.stop();
  expect(recorder.stop).toHaveBeenCalledOnce();
  await recorder.finish();
  await voice.start();
  expect(getUserMedia).toHaveBeenCalledOnce();
});

it("bounds accumulated recording bytes including the final chunk", async () => {
  await voice.start();
  const recorder = FakeRecorder.instances[0];
  recorder.chunk("a".repeat(25 * 1024 * 1024));
  expect(voice.state.phase).toBe("recording");
  voice.stop(); recorder.chunk("overflow"); await recorder.finish();
  expect(voice.state.phase).toBe("idle");
  expect(voice.state.error).toMatch(/25 MiB/);
  expect(voice.state.file).toBeNull();
  for (const track of tracks) expect(track.stop).toHaveBeenCalled();
});

it("stops automatically at five minutes without sending or keeping the microphone open", async () => {
  await voice.start();
  const recorder = FakeRecorder.instances[0];
  recorder.chunk();
  vi.advanceTimersByTime(300_000);
  expect(voice.state.phase).toBe("stopping");
  expect(recorder.stop).toHaveBeenCalledOnce();
  for (const track of tracks) expect(track.stop).toHaveBeenCalled();
  await recorder.finish();
  expect(voice.state.phase).toBe("preview");
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["denied", "unsupported", "construction", "start", "stop", "recorder", "empty", "unknown output"])("fails safely on %s with cleanup and a retryable error", async (failure) => {
  if (failure === "denied") getUserMedia.mockRejectedValue(new DOMException("Denied", "NotAllowedError"));
  if (failure === "unsupported") vi.stubGlobal("MediaRecorder", undefined);
  if (failure === "construction") vi.stubGlobal("MediaRecorder", class { constructor() { throw new Error("device busy"); } });
  // Browser methods can throw even after successful permission negotiation.
  if (failure === "start") vi.stubGlobal("MediaRecorder", class extends FakeRecorder { start = vi.fn(() => { throw new Error("start failed"); }); });
  await expect(voice.start()).resolves.toBeUndefined();
  const recorder = FakeRecorder.instances[0];
  if (failure === "stop") recorder.stop.mockImplementation(() => { throw new Error("stop failed"); });
  if (failure === "recorder") recorder.onerror?.();
  if (["empty", "unknown output", "stop"].includes(failure)) {
    if (failure === "unknown output") recorder.chunk("bytes", "video/unknown");
    voice.stop(); await recorder.finish();
  }
  expect(voice.state.phase).toBe("idle");
  expect(voice.state.error).toBeTruthy();
  expect(voice.state.file).toBeNull();
  if (!["denied", "unsupported"].includes(failure)) for (const track of tracks) expect(track.stop).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  ["audio/ogg;codecs=opus", "audio/ogg", "ogg"],
  ["audio/mp4", "audio/mp4", "m4a"],
  ["", "audio/webm", "webm"],
])("negotiates %s and uses the actual output MIME", async (supported, type, extension) => {
  FakeRecorder.isTypeSupported.mockImplementation((mime) => mime === supported);
  await voice.start();
  const recorder = FakeRecorder.instances[0];
  recorder.chunk(); voice.stop(); await recorder.finish();
  expect(voice.state.file).toMatchObject({ type, name: `voice-message.${extension}` });
});

it("cancels a running recorder and ignores already queued recorder callbacks", async () => {
  await voice.start();
  const recorder = FakeRecorder.instances[0];
  const queuedStop = recorder.onstop!;
  const queuedChunk = recorder.ondataavailable!;
  voice.cancel();
  expect(recorder.stop).toHaveBeenCalledOnce();
  expect(recorder.onstop).toBeNull();
  expect(recorder.ondataavailable).toBeNull();
  queuedChunk({ data: new Blob(["stale"]) }); queuedStop();
  expect(voice.state.phase).toBe("idle");
  expect(voice.state.file).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

it("discards permission granted after cancellation without starting a recorder", async () => {
  let resolve!: (value: MediaStream) => void;
  getUserMedia.mockReturnValue(new Promise<MediaStream>((done) => { resolve = done; }));
  const pending = voice.start();
  voice.cancel();
  resolve(stream);
  await pending;
  expect(voice.state.phase).toBe("idle");
  expect(FakeRecorder.instances).toHaveLength(0);
  for (const track of tracks) expect(track.stop).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("requests on start, records elapsed time, and stops to a MIME-matched preview file", async () => {
  expect(getUserMedia).not.toHaveBeenCalled();
  const start = voice.start();
  expect(voice.state.phase).toBe("requesting");
  await start;
  expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
  expect(voice.state.phase).toBe("recording");
  const recorder = FakeRecorder.instances[0];
  expect(recorder.start).toHaveBeenCalledWith(1000);
  vi.advanceTimersByTime(2100);
  expect(voice.state.elapsedSeconds).toBe(2);
  voice.stop();
  expect(voice.state.phase).toBe("stopping");
  recorder.chunk(); await recorder.finish();
  expect(voice.state.phase).toBe("preview");
  expect(voice.state.file).toMatchObject({ type: "audio/webm", name: "voice-message.webm", size: 5 });
  for (const track of tracks) expect(track.stop).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
