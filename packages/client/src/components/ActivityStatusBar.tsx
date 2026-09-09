import { useStreamingParts, useIsStreaming, getStreamStartTime } from "../stores/streaming";
import { useElapsedTime } from "../hooks/useElapsedTime";
import { deriveActivity, type ActivityPhase } from "../lib/derive-activity";

const PHASE_LABELS: Record<ActivityPhase, string> = {
  starting: "Starting...",
  thinking: "Thinking...",
  working: "Working...",
  responding: "Responding...",
  "waiting-permission": "Waiting for permission...",
};

const PHASE_DOT_COLORS: Record<ActivityPhase, string> = {
  starting: "bg-accent",
  thinking: "bg-accent",
  working: "bg-accent",
  responding: "bg-success",
  "waiting-permission": "bg-warning-text",
};

export function ActivityStatusBar({
  convId,
  hasPendingPermission,
}: {
  convId: string | undefined;
  hasPendingPermission: boolean;
}) {
  const isStreaming = useIsStreaming(convId);
  const parts = useStreamingParts(convId);
  const startTime = convId ? getStreamStartTime(convId) : null;
  const elapsed = useElapsedTime(isStreaming ? startTime : null);

  if (!isStreaming || !convId) return null;

  const activity = deriveActivity(parts ?? [], hasPendingPermission);
  const label = PHASE_LABELS[activity.phase];
  const dotColor = PHASE_DOT_COLORS[activity.phase];

  return (
    <div className="border-t border-border-subtle bg-base px-4 py-2">
      <div className="flex items-center gap-2">
        {/* Pulsing dot */}
        <span
          className={`inline-block size-2 shrink-0 rounded-full ${dotColor}`}
          style={{ animation: "pulse 1.5s infinite" }}
        />

        {/* Shimmer header text */}
        <span
          className="flex-1 text-[0.857rem] font-medium text-text-muted"
          style={{
            backgroundImage:
              "linear-gradient(90deg, var(--color-text-muted) 0%, var(--color-text) 50%, var(--color-text-muted) 100%)",
            backgroundSize: "200% 100%",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            animation: "shimmer 2s linear infinite",
          }}
        >
          {label}
        </span>

        {/* Elapsed time */}
        {elapsed && (
          <span className="shrink-0 text-[0.786rem] tabular-nums text-text-dimmed">
            {elapsed}
          </span>
        )}
      </div>

      {/* Detail lines — active tool calls */}
      {activity.details.length > 0 && (
        <div className="mt-1 flex flex-col gap-0.5 pl-4">
          {activity.details.map((detail, i) => (
            <span key={i} className="truncate text-[0.786rem] text-text-dimmed">
              {detail}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
