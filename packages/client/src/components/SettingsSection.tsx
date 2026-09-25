import type { ReactNode } from "react";
import { buttonClass, inputClass } from "./ui";

/**
 * Shared presentation for the Settings page: one grouped card per section with
 * labelled rows inside. Platform shells reuse these so their sections match
 * the shared route without duplicating utility classes.
 */

export const settingsCard =
  "divide-y divide-border-subtle overflow-hidden rounded-xl border border-border bg-white/[0.03]";

export const settingsRow =
  "grid min-w-0 gap-2 px-4 py-3.5 sm:grid-cols-[180px_minmax(0,1fr)] sm:items-start sm:gap-6 sm:px-5";

export const settingsLabel = "text-[0.929rem] font-medium leading-5 text-text";
export const settingsHint = "mt-0.5 text-[0.857rem] leading-5 text-text-dimmed";
export const settingsValue = "text-[0.929rem] leading-5 text-text-muted";

export const settingsInput = `${inputClass} h-8 max-sm:h-[44px] max-sm:text-[16px]`;

// Touch targets are declared in pixels: the root font size is 14px, so a
// rem-based h-11 would render below 44px.
const settingsButtonExtras =
  "shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent max-sm:h-[44px]";

export const settingsPrimaryButton = `${buttonClass("primary", "md")} ${settingsButtonExtras}`;
export const settingsSecondaryButton = `${buttonClass("secondary", "md")} ${settingsButtonExtras}`;
export const settingsQuietButton = `${buttonClass("ghost", "md")} ${settingsButtonExtras}`;
export const settingsDangerButton = `${buttonClass("danger", "md")} ${settingsButtonExtras}`;

export function SettingsSection({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-3">
      <div className="min-w-0 px-1">
        <h2 id={id} className="text-[1rem] font-semibold leading-6 text-text">
          {title}
        </h2>
        {description && (
          <p className="mt-0.5 max-w-[600px] text-[0.929rem] leading-5 text-text-muted">
            {description}
          </p>
        )}
      </div>
      {children}
    </section>
  );
}

/** A labelled control row: `<label>` on the left, the control on the right. */
export function SettingsField({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: ReactNode;
  htmlFor: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={settingsRow}>
      <div className="min-w-0 sm:pt-1.5">
        <label htmlFor={htmlFor} className={`block ${settingsLabel}`}>
          {label}
        </label>
        {hint && <p className={settingsHint}>{hint}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** A read-only term/value row for use inside a `<dl>`. */
export function SettingsFact({
  term,
  hint,
  mono = false,
  children,
}: {
  term: ReactNode;
  hint?: ReactNode;
  mono?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={settingsRow}>
      <dt className={`min-w-0 ${settingsLabel}`}>
        {term}
        {hint && <span className={`block font-normal ${settingsHint}`}>{hint}</span>}
      </dt>
      <dd
        className={`min-w-0 break-all ${
          mono ? "font-mono text-[0.857rem] leading-5 text-text-muted" : settingsValue
        }`}
      >
        {children}
      </dd>
    </div>
  );
}
