import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { VoiceRecording } from "./voice-recording";

// Real Chromium MediaRecorder output, 1s timeslices, Web Audio oscillator source.
// The original fixture decodes with duration=Infinity (capture script in evidence).
const bytes = Uint8Array.from(readFileSync("src/lib/__fixtures__/voice-without-duration.webm"));
const readBlob = (blob: Blob) => new Promise<ArrayBuffer>(resolve => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result as ArrayBuffer);
  reader.readAsArrayBuffer(blob);
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("writes measured WebM duration metadata without transcoding the recorded payload", async () => {
  let recorder!: { ondataavailable?: (event: { data: Blob }) => void; onstop?: () => void | Promise<void> };
  const stopTrack = vi.fn();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: stopTrack }] }) } });
  vi.stubGlobal("MediaRecorder", class {
    static isTypeSupported = () => true;
    state = "inactive";
    mimeType = "audio/webm";
    constructor() { recorder = this; }
    ondataavailable?: (event: { data: Blob }) => void;
    onstop?: () => void | Promise<void>;
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; }
  });
  let now = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const voice = new VoiceRecording(() => {});
  try {
    await voice.start();
    now = 2300;
    voice.stop();
    now = 2750; // Encoder flushing is not recording time.
    recorder.ondataavailable?.({ data: new Blob([bytes], { type: "audio/webm" }) });
    await recorder.onstop?.();
    expect(voice.state.phase).toBe("preview");
    const fixed = new Uint8Array(await readBlob(voice.state.file!));
    const index = fixed.findIndex((byte, i) => byte === 0x44 && fixed[i + 1] === 0x89 && fixed[i + 2] === 0x88);
    expect(index, "WebM Info must contain an 8-byte Duration element").toBeGreaterThan(-1);
    expect(new DataView(fixed.buffer).getFloat64(index + 3)).toBeCloseTo(1300);
    expect(fixed.slice(-64)).toEqual(bytes.slice(-64));
    expect(voice.state.file?.type).toBe("audio/webm");
    expect(stopTrack).toHaveBeenCalled();
  } finally { voice.cancel(); }
});
