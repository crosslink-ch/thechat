import { CircleAlert } from "lucide-react";

interface MessageSendErrorProps {
  error?: string | null;
}

export function MessageSendError({ error }: MessageSendErrorProps) {
  if (!error) return null;

  return (
    <div
      role="alert"
      className="flex items-center gap-2 border-t border-error-msg-border bg-error-msg-bg px-5 py-2 text-[0.857rem] text-error-bright"
    >
      <CircleAlert size={14} aria-hidden="true" className="shrink-0" />
      <span className="min-w-0">Message not sent: {error}</span>
    </div>
  );
}
