import { ThinkingOrb, type OrbState } from "thinking-orbs";

/**
 * Animated agent-activity indicator (thinking-orbs), e.g. `solving` beside
 * "Thinking" and `composing` on a working agent. The library ships two tuned
 * designs (20 and 64px); `size` picks the nearer one unless `design` says
 * otherwise, and the orb renders at the requested footprint. Decorative unless
 * a `label` is given.
 */
export function OrbLoader({
  state,
  size = 20,
  design = size < 42 ? "inline" : "avatar",
  invert = false,
  label,
  className,
}: {
  state: OrbState;
  /** Rendered size in CSS px. */
  size?: number;
  /** Tuned design: `inline` (20px, fewer dots) or `avatar` (64px, finer). */
  design?: "inline" | "avatar";
  /** Dark ink, for an orb drawn on a light disc. */
  invert?: boolean;
  label?: string;
  className?: string;
}) {
  return (
    <ThinkingOrb
      state={state}
      size={design === "inline" ? 20 : 64}
      theme={invert ? "light" : "dark"}
      className={className}
      style={{ width: size, height: size }}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}
