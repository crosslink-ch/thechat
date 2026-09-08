interface MessageSendErrorProps {
  error?: string | null;
}

export function MessageSendError({ error }: MessageSendErrorProps) {
  if (!error) return null;

  return (
    <div
      role="alert"
      className="border-t border-error-msg-border bg-error-msg-bg px-5 py-2 text-[0.857rem] text-error-bright"
    >
      Message not sent: {error}
    </div>
  );
}
