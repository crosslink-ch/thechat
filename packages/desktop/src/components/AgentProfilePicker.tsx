import type { AcpProfile } from "@thechat/shared";

interface AgentProfilePickerProps {
  profiles: AcpProfile[];
  value: string | null;
  onChange: (profileId: string | null) => void;
  locked?: boolean;
  compact?: boolean;
}

export function AgentProfilePicker({
  profiles,
  value,
  onChange,
  locked = false,
  compact = false,
}: AgentProfilePickerProps) {
  const selected = profiles.find((profile) => profile.id === value);
  const missing = Boolean(value && !selected);
  const unavailable = Boolean(missing || selected?.disabled);

  return (
    <div className={`flex min-w-0 flex-col ${compact ? "gap-0.5" : "gap-1.5"}`}>
      <select
        aria-label="Agent profile"
        value={value ?? ""}
        disabled={locked}
        onChange={(event) => onChange(event.target.value || null)}
        className="h-8 max-w-[230px] rounded-md border border-border bg-raised px-2 text-[0.786rem] text-text-secondary outline-none focus:border-accent disabled:cursor-default disabled:opacity-70"
      >
        <option value="" disabled>
          Select agent profile
        </option>
        {missing && (
          <option value={value!} disabled>
            {value} (unavailable)
          </option>
        )}
        {profiles.map((profile) => (
          <option
            key={profile.id}
            value={profile.id}
            disabled={profile.disabled}
          >
            {profile.name}{profile.disabled ? " (disabled)" : ""}
          </option>
        ))}
      </select>
      {!compact && locked && (
        <span className="text-[0.714rem] text-text-dimmed">
          Profile locked for this conversation
        </span>
      )}
      {!compact && unavailable && value && (
        <span role="alert" className="text-[0.714rem] text-error-bright">
          Profile {value} is unavailable. TheChat will not choose another profile automatically.
        </span>
      )}
    </div>
  );
}
