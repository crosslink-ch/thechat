import type { BackgroundActivityPublic } from "@thechat/shared";
import { backgroundTaskTerminal } from "@thechat/shared";
import { useEffect, useId, useState } from "react";

export function BackgroundActivityCard({ task, onStop }: { task: BackgroundActivityPublic; onStop?: (task: BackgroundActivityPublic) => Promise<void> }) {
  const [now, setNow] = useState(Date.now);
  const [expanded, setExpanded] = useState(false);
  const [stopState, setStopState] = useState<"idle" | "sending" | "requested">("idle");
  const [stopError, setStopError] = useState(false);
  const timelineId = useId();
  const terminal = backgroundTaskTerminal(task.parent.state);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 10_000); return () => clearInterval(timer); }, []);
  const stale = !terminal && (task.parent.state === "unknown" || now - Date.parse(task.observedAt) > 90_000);
  return <article data-testid="background-activity-card" data-activity-task-id={task.taskId} className="min-w-0 rounded-lg border border-border bg-raised p-3 text-[0.857rem] text-text">
    <h3 className="font-semibold">{terminal ? task.parent.state === "finished" ? "Finished" : task.parent.state === "failed" ? "Failed" : "Stopped" : stale ? "Status unknown" : "Working in background"}</h3>
    <p className="mt-1 text-text-secondary">{stale ? "Status unknown / connection lost" : parentLabel[task.parent.state]}</p>
    {task.parent.action && <p className="break-words text-text-muted">{task.parent.action} <time dateTime={task.parent.updatedAt}>{new Date(task.parent.updatedAt).toLocaleTimeString()}</time></p>}
    <ul className="mt-2 space-y-2">
      {task.workers.map(worker => <li key={worker.id} className="min-w-0 break-words">
        <p className="font-medium">{worker.goal}</p>
        <p className="text-text-muted">{worker.state}</p>
        {worker.action && <p>{worker.action} {worker.lastActionAt && <time dateTime={worker.lastActionAt} className="text-text-dimmed">{new Date(worker.lastActionAt).toLocaleTimeString()}</time>}</p>}
      </li>)}
    </ul>
    <button type="button" aria-expanded={expanded} aria-controls={timelineId} onClick={() => setExpanded(value => !value)} className="mt-3 rounded px-1 py-1 text-text-muted hover:text-text focus-visible:outline focus-visible:outline-accent">Recent activity</button>
    <ol id={timelineId} hidden={!expanded} className="mt-1 max-h-56 space-y-1 overflow-y-auto break-words text-text-dimmed">
      {task.activities.slice(-40).map(activity => <li key={activity.id}><span>{activity.toolName} · {activity.state}</span> <time dateTime={activity.finishedAt ?? activity.startedAt}>{new Date(activity.finishedAt ?? activity.startedAt).toLocaleTimeString()}</time></li>)}
    </ol>
    {!terminal && onStop && <div className="mt-2 border-t border-border pt-2">
      <p className="text-[0.714rem] text-text-dimmed">Stops this task and its owned background workers.</p>
      <button type="button" disabled={stopState !== "idle"} onClick={async () => {
        setStopError(false); setStopState("sending");
        try { await onStop(task); setStopState("requested"); }
        catch { setStopState("idle"); setStopError(true); }
      }} className="mt-1 rounded border border-border px-2 py-1 hover:bg-hover disabled:opacity-60 focus-visible:outline focus-visible:outline-accent">{stopState === "requested" ? "Stop requested" : stopState === "sending" ? "Requesting stop…" : "Stop task"}</button>
      {stopError && <p role="alert" className="mt-1 text-error-bright">Could not request stop. Try again.</p>}
    </div>}
  </article>;
}
const parentLabel: Record<BackgroundActivityPublic["parent"]["state"], string> = { working:"Working", waiting_worker:"Waiting for worker", waiting_user:"Waiting for you", waiting_external:"Waiting for external service", verifying:"Verifying results", finished:"Results delivered", failed:"Task failed", stopped:"Task stopped", unknown:"Status unknown / connection lost" };
