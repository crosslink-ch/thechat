import {
  ChevronRight,
  type LucideIcon,
} from "lucide-react";
import { OrbLoader } from "./OrbLoader";

/** Building blocks shared by Hermes activity views (live timeline, work logs). */

export function ExpandChevron({
  expanded,
  className = "",
}: {
  expanded: boolean;
  className?: string;
}) {
  return (
    <ChevronRight
      size={14}
      aria-hidden="true"
      className={`shrink-0 text-text-dimmed transition-transform duration-150 ${
        expanded ? "rotate-90" : ""
      } ${className}`}
    />
  );
}

/** A finished step's marker: a small muted icon for what the step did. */
export function StepIcon({
  icon: Icon,
  className = "text-text-dimmed",
}: {
  icon: LucideIcon;
  className?: string;
}) {
  return (
    <span className={`flex size-5 shrink-0 items-center justify-center ${className}`}>
      <Icon size={15} aria-hidden="true" />
    </span>
  );
}

/** Animated marker for the step in progress. */
export function StepOrb({ state }: { state: "solving" | "working" }) {
  return <OrbLoader state={state} size={20} className="shrink-0" />;
}
