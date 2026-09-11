import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { onSessionReset, sessionGeneration } from "../lib/session-boundary";
import type { ChatAttachment } from "@thechat/shared";
import { getAttachmentDownloadUrl, openSharedAttachmentDownload } from "../lib/shared-attachments";
import { VoiceAudioPlayer } from "./VoiceAudioPlayer";

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
  // Cookie sessions have no JS token: capabilities belong to a session generation.
  const generation = useSyncExternalStore(onSessionReset, sessionGeneration);
  return <ScopedVoiceMessagePlayer key={`${generation}:${props.token}:${props.attachment.id}`} {...props} />;
}

function ScopedVoiceMessagePlayer({ attachment, token }: VoiceMessagePlayerProps) {
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const downloadingRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const download = async () => {
    if (downloadingRef.current) return;
    downloadingRef.current = true;
    setDownloading(true);
    setSaved(false);
    setError(null);
    const generation = sessionGeneration();
    const active = () => mounted.current && generation === sessionGeneration();
    try {
      await openSharedAttachmentDownload(attachment.id, token, "attachment", attachment.fileName);
      if (active()) setSaved(true);
    } catch (caught) {
      if (active()) setError(caught instanceof Error ? caught.message : typeof caught === "string" && caught.trim() ? caught : "The audio could not be downloaded.");
    } finally {
      downloadingRef.current = false;
      if (active()) setDownloading(false);
    }
  };

  return (
    <div data-testid="voice-message-player" className="voice-message" title={attachment.fileName}>
      <VoiceAudioPlayer audioLabel={`Audio: ${attachment.fileName}`} loadSource={async () => {
        // Audio remains attachment-disposition on the server; only the constrained
        // decoder consumes this capability, lazily after an explicit Play.
        return (await getAttachmentDownloadUrl(attachment.id, token, "attachment")).url;
      }} />
      <button type="button" className="voice-download" disabled={downloading} aria-label={`Download ${attachment.fileName}`} title={`Download ${attachment.fileName}`} onClick={() => void download()}>
        <svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12m-4-4 4 4 4-4M5 17v3h14v-3" /></svg>
      </button>
      {saved && <p role="status" className="voice-notice">Saved to Downloads</p>}
      {error && <p role="alert" className="voice-notice">{error}</p>}
    </div>
  );
}
