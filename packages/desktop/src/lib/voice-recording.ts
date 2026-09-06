import { SHARED_ATTACHMENT_MAX_BYTES } from "./shared-attachments";

export interface VoiceRecordingState {
  phase: "idle" | "requesting" | "recording" | "stopping" | "preview";
  elapsedSeconds: number;
  file: File | null;
  error: string | null;
}

/** One ephemeral capture. No upload or send side effects. */
export class VoiceRecording {
  state: VoiceRecordingState = { phase: "idle", elapsedSeconds: 0, file: null, error: null };
  private stream?: MediaStream;
  private recorder?: MediaRecorder;
  private timer?: ReturnType<typeof setInterval>;
  private chunks: Blob[] = [];
  private generation = 0;

  constructor(private readonly onChange: (state: VoiceRecordingState) => void) {}

  private update(patch: Partial<VoiceRecordingState>) {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }

  async start() {
    if (this.state.phase !== "idle") return;
    this.update({ phase: "requesting", elapsedSeconds: 0, file: null, error: null });
    const generation = ++this.generation;
    try {
      if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        throw new Error("Voice recording is unavailable in this browser. Try a supported browser or attach an audio file.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;
      const mimeType = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find(
        (type) => MediaRecorder.isTypeSupported?.(type),
      );
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      this.recorder = recorder;
      this.chunks = [];
      let size = 0;
      recorder.ondataavailable = (event) => {
        if (generation !== this.generation || !event.data.size) return;
        size += event.data.size;
        if (size > SHARED_ATTACHMENT_MAX_BYTES) {
          this.fail("Recording exceeds 25 MiB. Please record a shorter message.");
          return;
        }
        this.chunks.push(event.data);
      };
      recorder.onerror = () => {
        if (generation === this.generation) this.fail("Microphone recording failed. Please try again.");
      };
      recorder.onstop = () => {
        if (generation !== this.generation) return;
        this.detachRecorder();
        this.release();
        const type = (this.chunks.find((chunk) => chunk.type)?.type || recorder.mimeType).split(";", 1)[0].trim().toLowerCase();
        const extension = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a" }[type];
        if (!extension || this.chunks.length === 0) {
          this.fail(extension ? "The recording was empty. Please try again." : "The microphone produced an unsupported audio format.");
          return;
        }
        this.update({ phase: "preview", file: new File(this.chunks, `voice-message.${extension}`, { type }) });
        this.chunks = [];
      };
      recorder.start(1000);
      const started = Date.now();
      this.timer = setInterval(() => {
        const elapsedSeconds = Math.floor((Date.now() - started) / 1000);
        this.update({ elapsedSeconds });
        if (elapsedSeconds >= 300) this.stop();
      }, 250);
      this.update({ phase: "recording" });
    } catch (error) {
      if (generation !== this.generation) return;
      this.fail(error instanceof DOMException && error.name === "NotAllowedError"
        ? "Microphone permission denied. Allow microphone access and try again."
        : error instanceof Error ? error.message : "Unable to record from the microphone.");
    }
  }

  stop() {
    if (this.state.phase !== "recording") return;
    this.update({ phase: "stopping" });
    try {
      this.recorder?.stop();
    } catch {
      this.fail("Could not finish the recording. Please try again.");
    } finally {
      this.release();
    }
  }

  private fail(error: string) {
    this.cancel();
    this.update({ error });
  }

  private release() {
    clearInterval(this.timer);
    this.timer = undefined;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
  }

  private detachRecorder() {
    const recorder = this.recorder;
    this.recorder = undefined;
    if (!recorder) return;
    recorder.onstop = null;
    recorder.ondataavailable = null;
    recorder.onerror = null;
    try {
      if (recorder.state !== "inactive") recorder.stop();
    } catch {
      // Track cleanup still owns microphone release when the recorder fails.
    }
  }

  cancel() {
    this.generation += 1;
    this.detachRecorder();
    this.chunks = [];
    this.release();
    this.update({ phase: "idle", file: null, elapsedSeconds: 0 });
  }
}
