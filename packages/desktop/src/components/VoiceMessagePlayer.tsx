import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { onSessionReset, sessionGeneration } from "../lib/session-boundary";
import type { ChatAttachment } from "@thechat/shared";
import {
  getAttachmentDownloadUrl,
  openSharedAttachmentDownload,
} from "../lib/shared-attachments";

const PLAYABLE_AUDIO_TYPES = new Set([
  "audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav",
  "audio/flac", "audio/aac", "audio/x-m4a", "audio/opus",
]);

export function isPlayableAudio(mediaType: string) {
  return PLAYABLE_AUDIO_TYPES.has(mediaType.split(";", 1)[0].trim().toLowerCase());
}

interface VoiceMessagePlayerProps {
  attachment: ChatAttachment;
  token: string | null;
}

export function VoiceMessagePlayer(props: VoiceMessagePlayerProps) {
  // Cookie sessions have no JS token, so token equality is not an account fence.
  const generation = useSyncExternalStore(onSessionReset, sessionGeneration);
  // A signed capability never survives an account or attachment change.
  return (
    <ScopedVoiceMessagePlayer
      key={`${generation}:${props.token}:${props.attachment.id}`}
      {...props}
    />
  );
}

function ScopedVoiceMessagePlayer({ attachment, token }: VoiceMessagePlayerProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const downloadingRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const loadingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    return () => {
      if (!audio) return;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    };
  }, [url]);

  const load = async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    const generation = sessionGeneration();
    try {
      // Audio stays an opaque, attachment-disposition download on the server.
      // Only this constrained media decoder consumes it, after a user action.
      const result = await getAttachmentDownloadUrl(
        attachment.id, token, "attachment",
      );
      if (mountedRef.current && generation === sessionGeneration()) setUrl(result.url);
    } catch (caught) {
      if (mountedRef.current) {
        setError(caught instanceof Error
          ? caught.message
          : "Audio could not be loaded. Please try again.");
      }
    } finally {
      loadingRef.current = false;
      if (mountedRef.current) setLoading(false);
    }
  };

  const download = async () => {
    if (downloadingRef.current) return;
    downloadingRef.current = true;
    setDownloading(true);
    setSaved(false);
    setError(null);
    try {
      await openSharedAttachmentDownload(
        attachment.id, token, "attachment", attachment.fileName,
      );
      if (mountedRef.current) setSaved(true);
    } catch (caught) {
      if (mountedRef.current) {
        setError(caught instanceof Error
          ? caught.message
          : typeof caught === "string" && caught.trim()
            ? caught
            : "The audio could not be downloaded.");
      }
    } finally {
      downloadingRef.current = false;
      if (mountedRef.current) setDownloading(false);
    }
  };

  return (
    <div className="w-80 max-w-full rounded-lg border border-border bg-raised p-3">
      <div className="mb-2 truncate text-sm text-text" title={attachment.fileName}>
        {attachment.fileName}
      </div>
      {url ? (
        <audio
          ref={audioRef}
          aria-label={`Audio: ${attachment.fileName}`}
          className="w-full"
          controls
          preload="none"
          src={url}
          onError={() => {
            setUrl(null);
            setError("Audio could not be played. Load it again or download the file.");
          }}
        />
      ) : (
        <button
          type="button"
          disabled={loading}
          onClick={() => void load()}
          aria-label={`Load audio ${attachment.fileName}`}
          className="cursor-pointer rounded border border-border px-3 py-1.5 text-sm text-text hover:bg-hover disabled:cursor-wait disabled:opacity-60"
        >
          {loading ? "Loading audio…" : "Load audio"}
        </button>
      )}
      <button
        type="button"
        disabled={downloading}
        aria-label={`Download ${attachment.fileName}`}
        title={`Download ${attachment.fileName}`}
        onClick={() => void download()}
        className="mt-2 block cursor-pointer text-xs text-text-dimmed underline hover:text-text disabled:cursor-wait disabled:opacity-60"
      >
        {downloading ? "Downloading…" : "Download"}
      </button>
      {saved && <p role="status" className="mt-1 text-xs text-text-dimmed">Saved to Downloads</p>}
      {error && <p role="alert" className="mt-2 text-xs text-error-bright">{error}</p>}
    </div>
  );
}
