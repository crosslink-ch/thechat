import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { flushSync } from "react-dom";
import { sessionGeneration } from "../lib/session-boundary";

interface VoiceAudioPlayerProps {
  audioLabel: string;
  label?: string;
  source?: string;
  loadSource?: () => Promise<string>;
  durationSeconds?: number;
  disabled?: boolean;
}

let activePlayback: (() => void) | null = null;

export function pauseVoicePlayback() {
  activePlayback?.();
}

/** A constrained audio decoder. Loading and playback require one explicit Play. */
export function VoiceAudioPlayer({ audioLabel, label = "voice message", source, loadSource, durationSeconds, disabled = false }: VoiceAudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const mounted = useRef(true);
  const pending = useRef(false);
  const attempt = useRef(0);
  const [url, setUrl] = useState(source ?? null);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [speed, setSpeed] = useState(1);

  const updateDuration = () => {
    const value = audioRef.current?.duration;
    if (value && Number.isFinite(value)) setDuration(value);
  };

  const pause = useCallback(() => {
    attempt.current++;
    pending.current = false;
    if (activePlayback === pause) activePlayback = null;
    audioRef.current?.pause();
    if (mounted.current) { setPlaying(false); setLoading(false); }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const audio = audioRef.current;
    // StrictMode replays setup after cleanup without reapplying unchanged DOM
    // props. Restore the local preview we own, but never authorize remote audio.
    if (audio && source && !audio.hasAttribute("src")) audio.src = source;
    return () => {
      mounted.current = false;
      pause();
      audio?.pause();
      audio?.removeAttribute("src");
      audio?.load();
    };
  }, [pause]);

  const play = async () => {
    const audio = audioRef.current;
    if (!audio || pending.current || disabled) return;
    if (playing) { pause(); return; }
    pauseVoicePlayback();
    activePlayback = pause;
    const current = ++attempt.current;
    const generation = sessionGeneration();
    const active = () => mounted.current && current === attempt.current && generation === sessionGeneration() && activePlayback === pause;
    pending.current = true;
    setLoading(true);
    setError(null);
    try {
      const nextUrl = url ?? source ?? await loadSource?.();
      if (!active() || !nextUrl) return;
      // Commit the source exactly once before play(). An imperative src write
      // followed by React's commit reloads the decoder and interrupts playback.
      // This remains in the explicit Play action, never an autoplay effect.
      flushSync(() => setUrl(nextUrl));
      if (audio.ended || (duration > 0 && audio.currentTime >= duration)) {
        audio.currentTime = 0;
        setPosition(0);
      }
      await audio.play();
      if (active()) setPlaying(true);
    } catch (caught) {
      if (active()) setError(caught instanceof Error ? caught.message : "Audio could not be played. Please try again.");
    } finally {
      if (active()) { pending.current = false; setLoading(false); }
    }
  };

  return (
    <div className="voice-audio-player">
      <audio ref={audioRef} hidden aria-label={url ? audioLabel : undefined} src={url ?? undefined} preload="none"
        onLoadedMetadata={updateDuration} onDurationChange={updateDuration}
        onTimeUpdate={() => setPosition(audioRef.current?.currentTime ?? 0)}
        onEnded={() => { pause(); updateDuration(); }}
        onPause={() => setPlaying(false)}
        onError={() => {
          attempt.current++;
          pending.current = false;
          setLoading(false);
          setPlaying(false);
          audioRef.current?.pause();
          audioRef.current?.removeAttribute("src");
          audioRef.current?.load();
          setUrl(null);
          setError("Audio could not be played. Try Play again or save the file.");
        }} />
      <button type="button" className="voice-play" disabled={loading || disabled} aria-label={`${playing ? "Pause" : "Play"} ${label}`} onClick={() => void play()} title={error ? "Retry playback" : undefined}>
        {loading ? <span className="voice-spinner" aria-hidden="true" /> : <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="currentColor">{playing ? <path d="M6 5h4v14H6zm8 0h4v14h-4z" /> : <path d="m8 4 12 8-12 8z" />}</svg>}
      </button>
      <div className="voice-timeline">
        <div className="voice-meta"><span>Voice message</span><span className="voice-time">{position > 0 && `${formatVoiceTime(position)} / `}{duration || durationSeconds !== undefined ? formatVoiceTime(duration || durationSeconds || 0) : ""}</span></div>
        <input className="voice-seek" type="range" min="0" max={duration || 1} step="0.1" value={Math.min(position, duration)}
          disabled={!duration || disabled} aria-label={`Seek ${label}`} aria-valuetext={`${formatVoiceTime(position)} of ${duration ? formatVoiceTime(duration) : "unknown duration"}`}
          style={{ "--voice-progress": `${duration ? position / duration * 100 : 0}%` } as CSSProperties}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (audioRef.current) audioRef.current.currentTime = next;
            setPosition(next);
          }} />
      </div>
      {error && <p className="voice-notice" role="alert">{error}</p>}
      <button type="button" className="voice-speed" disabled={disabled} aria-label={`Playback speed ${speed}×`} title="Change playback speed" onClick={() => {
        const next = speed === 1 ? 1.5 : speed === 1.5 ? 2 : 1;
        if (audioRef.current) {
          audioRef.current.defaultPlaybackRate = next;
          audioRef.current.playbackRate = next;
        }
        setSpeed(next);
      }}>{speed}×</button>
    </div>
  );
}

export function formatVoiceTime(seconds: number) {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}
