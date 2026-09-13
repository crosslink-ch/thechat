import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { VoiceRecording } from "../lib/voice-recording";
import { onSessionReset, sessionGeneration } from "../lib/session-boundary";
import { cancelSharedAttachment, uploadSharedAttachment } from "../lib/shared-attachments";
import { VoiceAudioPlayer, formatVoiceTime, pauseVoicePlayback } from "./VoiceAudioPlayer";
import { services } from "#platform-services";

interface VoiceRecorderProps {
  disabled: boolean;
  scope: { conversationId: string; token: string | null };
  onSend: (attachmentId: string) => Promise<boolean>;
  onBusyChange: (busy: boolean) => void;
}

export function VoiceRecorder(props: VoiceRecorderProps) {
  const generation = useSyncExternalStore(onSessionReset, sessionGeneration);
  return <ScopedVoiceRecorder key={generation} {...props} />;
}

function ScopedVoiceRecorder({ onSend, scope, onBusyChange, disabled }: VoiceRecorderProps) {
  const mounted = useRef(true);
  const [recording] = useState(() => new VoiceRecording((next) => {
    if (mounted.current) {
      setState(next);
      onBusyChange(next.phase !== "idle" || Boolean(next.error));
    }
  }));
  const [state, setState] = useState(recording.state);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const [sending, setSending] = useState(false);
  const [transfer, setTransfer] = useState({ phase: "hashing", progress: 0 });
  const [awaitingAck, setAwaitingAck] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const readyAttachmentId = useRef<string | null>(null);
  const incompleteAttachmentId = useRef<string | null>(null);
  const uploadController = useRef<AbortController | null>(null);
  const generation = useRef(sessionGeneration());
  const [permission, setPermission] = useState<"checking" | "prompt" | "denied" | null>(null);
  const permissionAttempt = useRef(0);

  const start = async () => {
    if (disabled || permission === "checking" || permission === "prompt" || recording.state.phase !== "idle") return;
    if (!services.microphone) { void recording.start(); return; }
    const attempt = ++permissionAttempt.current;
    setPermission("checking");
    onBusyChange(true);
    try {
      const result = await services.microphone.getPermissionState();
      if (!mounted.current || attempt !== permissionAttempt.current || generation.current !== sessionGeneration()) return;
      if (result !== "granted") setPermission(result);
      else { setPermission(null); void recording.start(); }
    } catch {
      if (mounted.current && attempt === permissionAttempt.current) { setPermission(null); onBusyChange(false); setSendError("Could not check microphone access. Please try again."); }
    }
  };

  const discard = useCallback(() => {
    permissionAttempt.current++;
    // Active transfers own abort cleanup; failed transfers leave a reservation
    // here so explicit retry/discard can clean it before another upload.
    const idleReservation = readyAttachmentId.current ?? (!uploadController.current ? incompleteAttachmentId.current : null);
    uploadController.current?.abort();
    uploadController.current = null;
    if (idleReservation && generation.current === sessionGeneration()) {
      void cancelSharedAttachment(idleReservation, scope.token).catch(() => undefined);
    }
    readyAttachmentId.current = null;
    incompleteAttachmentId.current = null;
    recording.cancel();
    if (mounted.current) { setPermission(null); setSending(false); setSendError(null); }
  }, [recording, scope.token]);

  const send = async () => {
    if (!state.file || disabled || uploadController.current) return;
    pauseVoicePlayback();
    setSending(true);
    setTransfer({ phase: "hashing", progress: 0 });
    setSendError(null);
    const controller = new AbortController();
    uploadController.current = controller;
    const active = () => mounted.current && !controller.signal.aborted && generation.current === sessionGeneration();
    let submittedId: string | null = null;
    try {
      if (!readyAttachmentId.current) {
        if (incompleteAttachmentId.current) {
          await cancelSharedAttachment(incompleteAttachmentId.current, scope.token);
          incompleteAttachmentId.current = null;
          if (!active()) return;
        }
        const attachment = await uploadSharedAttachment({ ...scope, file: state.file, signal: controller.signal }, (update) => {
          if (active()) {
            setTransfer({ phase: update.phase, progress: update.progress });
            if (update.attachment) incompleteAttachmentId.current = update.attachment.id;
          }
        });
        if (!active()) {
          if (generation.current === sessionGeneration()) void cancelSharedAttachment(attachment.id, scope.token).catch(() => undefined);
          return;
        }
        readyAttachmentId.current = attachment.id;
        incompleteAttachmentId.current = null;
      }
      // Transfer ownership to the message while its acknowledgement is pending.
      // Navigation must never DELETE a reservation the server may be binding.
      submittedId = readyAttachmentId.current;
      readyAttachmentId.current = null;
      setAwaitingAck(true);
      if (await onSend(submittedId)) {
        submittedId = null;
        if (active()) recording.cancel();
      }
      else if (active()) setSendError("Message was not sent. Your recording is ready to retry.");
    } catch (error) {
      if (active()) setSendError(error instanceof Error ? error.message : "Could not send voice message.");
    } finally {
      if (submittedId) {
        if (active()) readyAttachmentId.current = submittedId;
        else if (generation.current === sessionGeneration()) void cancelSharedAttachment(submittedId, scope.token).catch(() => undefined);
      }
      if (uploadController.current === controller) uploadController.current = null;
      if (active()) { setSending(false); setAwaitingAck(false); }
    }
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      discard();
      onBusyChange(false);
    };
  }, [discard]);

  // Reset immediately, including a getUserMedia request still awaiting permission.
  useEffect(() => onSessionReset(discard), [discard]);

  useEffect(() => {
    if (disabled && (recording.state.phase !== "idle" || permission)) discard();
  }, [disabled, recording, discard, permission]);

  useEffect(() => {
    if (!state.file) { setPreviewUrl(null); return; }
    const url = URL.createObjectURL(state.file);
    setPreviewUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [state.file]);

  const elapsed = formatVoiceTime(state.elapsedSeconds);
  return (
    <div className={state.phase === "idle" && !permission && !state.error ? "voice-record-trigger" : "voice-recorder"} aria-label="Voice recording">
      {permission || state.error ? (
        <div className="voice-permission">
          <div className="voice-permission-icon" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" /></svg></div>
          <div className="voice-permission-content"><strong>{permission === "checking" ? "Checking microphone access" : permission === "denied" || state.error ? "Let’s connect your microphone" : "Your voice, when you choose"}</strong>
            {permission === "denied" || state.error ? <p role="alert" className="voice-helper">{permission === "denied" ? "TheChat has a saved microphone block. Windows settings cannot reset this app-specific choice. Resetting saved WebView permissions is not available here yet; the previous choice has been kept." : state.error}</p> : <p className="voice-helper">TheChat uses your microphone only while you record. Listen back before you send. Windows privacy settings stay in control.</p>}
            <div className="voice-permission-actions">
              {permission === "prompt" && <button type="button" className="voice-send" disabled={disabled} onClick={() => { if (!disabled) { setPermission(null); void recording.start(); } }}>Allow microphone and record</button>}
              {(permission === "denied" || state.error) && <>
                <button type="button" className="voice-send" disabled={disabled} aria-label="Record voice message" onClick={() => void start()}>Try again</button>
                {services.microphone && permission !== "denied" && <button type="button" className="voice-secondary" onClick={() => { void services.microphone?.openSettings().catch(() => { if (mounted.current) setSendError("Open Windows Settings → Privacy & security → Microphone to allow access."); }); }}>Open microphone settings</button>}
              </>}
              <button type="button" className="voice-secondary" onClick={discard}>Not now</button>
            </div>
          </div>
        </div>
      ) : state.phase === "idle" ? (
        <button type="button" disabled={disabled} onClick={() => void start()} aria-label="Record voice message" title="Record voice message" className="flex size-8 items-center justify-center rounded-lg text-text-dimmed hover:bg-hover disabled:opacity-25">
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <rect x="9" y="2" width="6" height="12" rx="3" />
            <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
          </svg>
        </button>
      ) : state.phase === "preview" ? (
        <>
          <div className="voice-recorder-heading"><span role="status">{sending ? awaitingAck ? "Sending your message…" : transfer.phase === "uploading" ? "Uploading your message…" : transfer.phase === "processing" ? "Preparing your message…" : "Getting your message ready…" : "Review your message"}</span><span>{sending ? "Your text draft stays here" : "Only you can hear this"}</span></div>
          <div className="voice-review-row">
            <button type="button" className="voice-discard" disabled={awaitingAck} onClick={discard} aria-label="Discard recording" title="Discard recording"><svg aria-hidden="true" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v-7" /></svg></button>
            {previewUrl && <VoiceAudioPlayer key={previewUrl} audioLabel="Voice message preview" label="voice message preview" source={previewUrl} durationSeconds={state.elapsedSeconds} disabled={sending} />}
            <button type="button" className="voice-send" disabled={disabled || sending} onClick={() => void send()} aria-label="Send voice message">{sending ? <span className="voice-spinner" aria-hidden="true" /> : <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m3 3 19 9-19 9 4-9-4-9Zm4 9h15" /></svg>}<span>{sending ? "Sending" : sendError ? "Retry" : "Send"}</span></button>
          </div>
          {sending && !awaitingAck && transfer.phase === "uploading" && <progress className="voice-recording-progress" aria-label="Uploading voice message" value={transfer.progress} max={100} />}
        </>
      ) : (
        <>
          <div className="voice-capture-row">
            <button type="button" className="voice-discard" onClick={discard} aria-label="Cancel recording" title="Cancel recording"><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
            <div className="voice-capture-info">
              <div className="voice-meta"><span role="status">{state.phase === "requesting" ? "Connecting your microphone" : state.phase === "stopping" ? "Finishing recording…" : <><i className="voice-recording-dot" aria-hidden="true" />Recording</>}</span>{state.phase === "recording" && <span className="voice-time" role="timer" aria-label="Recording duration">{elapsed}<span className="voice-time-limit"> / 5:00</span></span>}</div>
              {state.phase === "recording" ? <progress className="voice-recording-progress" value={state.elapsedSeconds} max={300} aria-label="Recording time limit" /> : <p className="voice-helper">{state.phase === "requesting" ? "Allow microphone access in the permission prompt. You can review before sending." : "Your microphone is off. Preparing your preview."}</p>}
            </div>
            {state.phase === "recording" && <button type="button" className="voice-stop" onClick={() => recording.stop()} aria-label="Stop recording" title="Stop and review"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="3" /></svg><span>Review</span></button>}
          </div>
        </>
      )}

      {sendError && <p className="voice-notice" role="alert">{sendError}</p>}
    </div>
  );
}
