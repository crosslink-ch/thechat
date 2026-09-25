import { useState } from "react";
import { Clock } from "lucide-react";
import {
  formatRunDuration,
  humanizeToolName,
  type KeepAliveRun,
  type KeepAliveUpdate,
} from "../lib/hermes-keepalive";
import { ExpandChevron, STEP_KINDS, StepIcon, toolKind } from "./hermes-steps";
import { OrbLoader } from "./OrbLoader";

/**
 * "Worked for 5m 56s ›" above a Hermes answer, built from the keep-alive
 * updates Hermes posted during the run. Opens to list those updates.
 */
export function HermesWorkLog({ run, live = false }: { run: KeepAliveRun; live?: boolean }) {
  const [open, setOpen] = useState(false);
  const duration = formatRunDuration(run);
  const label = live
    ? duration ? `Working for ${duration}` : "Working"
    : duration ? `Worked for ${duration}` : "Worked on this";

  return (
    <div className="mb-1 min-w-0" data-testid="hermes-work-log">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex max-w-full cursor-pointer items-center gap-1.5 rounded-md py-0.5 text-left text-[0.929rem] text-text-dimmed transition-colors hover:text-text-secondary"
      >
        {live && <OrbLoader state="composing" size={16} className="shrink-0" />}
        <span className={`truncate ${live ? "live-shine" : ""}`}>{label}</span>
        <ExpandChevron expanded={open} />
      </button>
      {open && (
        <div className="mb-1 ml-1.5 mt-0.5 border-l border-border-subtle pl-2">
          {run.updates.map((update) => (
            <WorkLogUpdate key={update.messageId} update={update} />
          ))}
        </div>
      )}
    </div>
  );
}

function WorkLogUpdate({ update }: { update: KeepAliveUpdate }) {
  const meta = [
    update.elapsedSeconds !== null ? elapsedLabel(update.elapsedSeconds) : null,
    update.iteration ? `step ${update.iteration}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      className="flex min-w-0 items-center gap-2 px-1 py-1 text-[0.929rem] text-text-muted"
      title={update.tool ?? undefined}
    >
      <StepIcon icon={update.tool ? STEP_KINDS[toolKind(update.tool)].icon : Clock} />
      <span className="min-w-0 truncate">
        {update.tool ? humanizeToolName(update.tool) : "Working"}
      </span>
      {meta && <span className="shrink-0 text-text-dimmed">· {meta}</span>}
    </div>
  );
}

function elapsedLabel(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)} min`;
}
