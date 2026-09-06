import { useEffect, useRef, useState } from "react";
import { VoiceRecording } from "../lib/voice-recording";

const actionClass = "rounded-lg px-3 py-2 text-xs font-medium text-text-muted hover:bg-hover disabled:opacity-40 disabled:cursor-default";

export function VoiceRecorder({ onAttach, onBusyChange, disabled }: {
  disabled: boolean;
  onAttach: (file: File) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const mounted = useRef(true);
  const [recording] = useState(() => new VoiceRecording((next) => {
    if (mounted.current) {
      setState(next);
      onBusyChange(next.phase !== "idle");
    }
  }));
  const [state, setState] = useState(recording.state);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      recording.cancel();
      onBusyChange(false);
    };
  }, [recording]);

  useEffect(() => {
    if (disabled && recording.state.phase !== "idle") recording.cancel();
  }, [disabled, recording]);

  useEffect(() => {
    if (!state.file) { setPreviewUrl(null); return; }
    const url = URL.createObjectURL(state.file);
    setPreviewUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [state.file]);

  useEffect(() => {
    const element = audio.current;
    return () => { element?.pause(); };
  }, [previewUrl]);

  const elapsed = `${Math.floor(state.elapsedSeconds / 60)}:${String(state.elapsedSeconds % 60).padStart(2, "0")}`;
  return (
    <div className="flex flex-wrap items-center gap-1" aria-label="Voice recording">
      {state.phase === "idle" ? (
        <button type="button" disabled={disabled} onClick={() => { if (!disabled) void recording.start(); }} aria-label="Record voice message" title="Record voice message" className="flex size-8 items-center justify-center rounded-lg text-text-dimmed hover:bg-hover disabled:opacity-25">
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <rect x="9" y="2" width="6" height="12" rx="3" />
            <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
          </svg>
        </button>
      ) : state.phase === "preview" ? (
        <>
          {previewUrl && <audio ref={audio} aria-label="Voice message preview" src={previewUrl} controls preload="none" className="h-10 max-w-full" />}
          <button type="button" className={actionClass} disabled={disabled} onClick={() => { if (!disabled && state.file) onAttach(state.file); recording.cancel(); }}>Attach recording</button>
          <button type="button" className={actionClass} onClick={() => recording.cancel()}>Discard recording</button>
        </>
      ) : (
        <>
          <span role="status" className="px-2 text-xs text-error-bright">
            {state.phase === "requesting" ? "Waiting for microphone permission…" : state.phase === "stopping" ? "Finishing recording…" : `● Recording ${elapsed} / 5:00`}
          </span>
          {state.phase === "recording" && <button type="button" className={actionClass} onClick={() => recording.stop()}>Stop recording</button>}
          <button type="button" className={actionClass} onClick={() => recording.cancel()}>Cancel recording</button>
        </>
      )}
      {state.error && <span role="alert" className="max-w-sm px-2 text-xs text-error-bright">{state.error}</span>}
    </div>
  );
}
