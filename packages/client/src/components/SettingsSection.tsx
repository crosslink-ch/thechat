import type { ReactNode } from "react";

/**
 * Shared presentation for the Settings page: one flat card per section with
 * labelled rows inside. Platform shells reuse these so their sections match
 * the shared route without duplicating utility classes.
 */

export const settingsCard =
  "divide-y divide-border-subtle overflow-hidden rounded-xl border border-border bg-surface";

export const settingsRow =
  "grid min-w-0 gap-2 px-4 py-4 sm:grid-cols-[160px_minmax(0,1fr)] sm:items-start sm:gap-6 sm:px-5";

export const settingsLabel = "text-[0.857rem] font-medium leading-5 text-text";
export const settingsHint = "mt-0.5 text-[0.786rem] leading-5 text-text-dimmed";
export const settingsValue = "text-[0.857rem] leading-5 text-text-muted";

export const settingsInput =
  "h-10 w-full min-w-0 rounded-lg border border-border bg-base px-3 text-[0.929rem] text-text outline-none transition-colors placeholder:text-text-placeholder focus:border-accent focus-visible:ring-2 focus-visible:ring-accent/30 disabled:cursor-wait disabled:opacity-70 max-sm:h-[44px] max-sm:text-[16px]";

const settingsButtonBase =
  "inline-flex shrink-0 cursor-pointer items-center justify-center whitespace-nowrap rounded-lg text-[0.857rem] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed max-sm:h-[44px]";

export const settingsPrimaryButton = `${settingsButtonBase} h-10 bg-accent px-4 font-semibold text-white hover:bg-accent/90 disabled:opacity-45`;
export const settingsSecondaryButton = `${settingsButtonBase} h-9 border border-border bg-raised px-3 text-text-secondary hover:bg-hover hover:text-text disabled:opacity-50`;
export const settingsQuietButton = `${settingsButtonBase} h-9 px-2.5 text-text-muted hover:bg-hover hover:text-text disabled:opacity-50`;
export const settingsDangerButton = `${settingsButtonBase} h-9 border border-error-msg-border bg-error-msg-bg px-3 text-error-bright hover:brightness-110 disabled:opacity-50`;

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
          <p className="mt-1 max-w-[600px] text-[0.857rem] leading-5 text-text-muted">
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
      <div className="min-w-0">
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
          mono ? "font-mono text-[0.786rem] leading-5 text-text-muted" : settingsValue
        }`}
      >
        {children}
      </dd>
    </div>
  );
}
