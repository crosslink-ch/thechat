import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AcpProfile, AppConfig } from "@thechat/shared";

interface ProfileTemplate {
  id: "codex" | "claude" | "opencode";
  label: string;
  executable: string;
  args: string[];
}

interface AcpProbeResult {
  resolvedExecutable: string;
  agentName?: string | null;
  agentVersion?: string | null;
}

export const ACP_PROFILE_TEMPLATES: ProfileTemplate[] = [
  {
    id: "codex",
    label: "Codex",
    executable: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp@1.7.0"],
  },
  {
    id: "claude",
    label: "Claude",
    executable: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp@0.70.0"],
  },
  {
    id: "opencode",
    label: "OpenCode",
    executable: "opencode",
    args: ["acp"],
  },
];

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_PROFILES = 32;
const MAX_ROWS = 64;

export function AgentProfilesSettings() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [profiles, setProfiles] = useState<AcpProfile[]>([]);
  const [defaultProfileId, setDefaultProfileId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [duplicateProfileId, setDuplicateProfileId] = useState<string | null>(null);
  const [testingProfile, setTestingProfile] = useState(false);
  const [probeMessage, setProbeMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.resolve(invoke<AppConfig>("get_config"))
      .then((loaded) => {
        if (!loaded) throw new Error("Configuration was unavailable.");
        if (!active) return;
        const loadedProfiles = loaded.acpProfiles ?? [];
        const validDefault = loadedProfiles.some(
          (profile) =>
            profile.id === loaded.defaultAcpProfileId && !profile.disabled,
        )
          ? loaded.defaultAcpProfileId ?? null
          : loadedProfiles.find((profile) => !profile.disabled)?.id ?? null;
        setConfig(loaded);
        setProfiles(loadedProfiles);
        setDefaultProfileId(validDefault);
      })
      .catch((loadError) => {
        if (active) setError(errorMessage(loadError));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const validationError = useMemo(
    () => validateProfiles(profiles, defaultProfileId),
    [profiles, defaultProfileId],
  );
  const duplicateProfile = profiles.find(
    (profile) => profile.id === duplicateProfileId,
  );

  const updateProfile = (
    profileId: string,
    update: (profile: AcpProfile) => AcpProfile,
  ) => {
    setProfiles((current) =>
      current.map((profile) =>
        profile.id === profileId ? update(profile) : profile,
      ),
    );
    setSaved(false);
    setError(null);
  };

  const addTemplate = (template: ProfileTemplate) => {
    if (profiles.length >= MAX_PROFILES) {
      setError(`A maximum of ${MAX_PROFILES} ACP profiles is supported.`);
      return;
    }
    const id = newProfileId(template.id);
    const next: AcpProfile = {
      id,
      name: template.label,
      executable: template.executable,
      args: [...template.args],
      inheritEnv: [],
    };
    setProfiles((current) => [...current, next]);
    if (!defaultProfileId) setDefaultProfileId(id);
    setSaved(false);
    setError(null);
  };

  const confirmDuplicate = () => {
    if (!duplicateProfile) return;
    if (profiles.length >= MAX_PROFILES) {
      setError(`A maximum of ${MAX_PROFILES} ACP profiles is supported.`);
      setDuplicateProfileId(null);
      return;
    }
    const copy: AcpProfile = {
      ...duplicateProfile,
      id: newProfileId(`${duplicateProfile.id}-copy`),
      name: `${duplicateProfile.name} copy`,
      args: [...duplicateProfile.args],
      inheritEnv: [...duplicateProfile.inheritEnv],
    };
    setProfiles((current) => [...current, copy]);
    setDuplicateProfileId(null);
    setSaved(false);
  };

  const deleteProfile = (profileId: string) => {
    const remaining = profiles.filter((profile) => profile.id !== profileId);
    setProfiles(remaining);
    if (defaultProfileId === profileId) {
      setDefaultProfileId(
        remaining.find((profile) => !profile.disabled)?.id ?? null,
      );
    }
    setSaved(false);
  };

  const setDisabled = (profileId: string, disabled: boolean) => {
    const nextProfiles = profiles.map((profile) =>
      profile.id === profileId ? { ...profile, disabled } : profile,
    );
    setProfiles(nextProfiles);
    if (disabled && defaultProfileId === profileId) {
      setDefaultProfileId(
        nextProfiles.find(
          (profile) => profile.id !== profileId && !profile.disabled,
        )?.id ?? null,
      );
    } else if (!disabled && !defaultProfileId) {
      setDefaultProfileId(profileId);
    }
    setSaved(false);
    setError(null);
  };

  const save = async () => {
    if (!config || validationError || saving) return;
    const updatedConfig: AppConfig = {
      ...config,
      acpProfiles: profiles.map((profile) => ({
        id: profile.id,
        name: profile.name.trim(),
        executable: profile.executable.trim(),
        args: [...profile.args],
        inheritEnv: profile.inheritEnv.map((name) => name.trim()),
        ...(profile.disabled ? { disabled: true } : {}),
      })),
      defaultAcpProfileId: defaultProfileId,
    };
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await invoke<void>("save_config", { config: updatedConfig });
      setConfig(updatedConfig);
      setSaved(true);
      window.dispatchEvent(new CustomEvent("acp-profiles-changed"));
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setSaving(false);
    }
  };

  const testDefaultProfile = async () => {
    if (!defaultProfileId || validationError || testingProfile) return;
    setTestingProfile(true);
    setProbeMessage(null);
    setError(null);
    try {
      const result = await invoke<AcpProbeResult>("acp_probe_profile", {
        profileId: defaultProfileId,
        cwd: null,
      });
      const agent = [result.agentName, result.agentVersion].filter(Boolean).join(" ");
      setProbeMessage(
        `Profile connected${agent ? ` to ${agent}` : ""} via ${result.resolvedExecutable}.`,
      );
    } catch (probeError) {
      setError(`Profile test failed: ${errorMessage(probeError)}`);
    } finally {
      setTestingProfile(false);
    }
  };

  if (loading) {
    return (
      <section className="rounded-xl border border-border-subtle bg-surface p-5">
        <p className="text-[0.857rem] text-text-muted">Loading agent profiles...</p>
      </section>
    );
  }

  return (
    <section
      className="rounded-xl border border-border-subtle bg-surface p-5 shadow-sm sm:p-6"
      aria-labelledby="agent-profiles-heading"
    >
      <div className="flex flex-col gap-1">
        <h2 id="agent-profiles-heading" className="text-[1rem] font-semibold text-text">
          Agent profiles
        </h2>
        <p className="text-[0.857rem] leading-5 text-text-muted">
          Configure trusted local ACP adapters as a direct executable plus literal arguments.
          ACP approvals are cooperative controls, not an OS sandbox: every adapter runs with
          your desktop user's OS identity.
        </p>
        <p className="text-[0.786rem] leading-5 text-warning-text">
          Inherit environment variable names only; values and secrets are never stored in a
          frontend profile. npx templates may download packages on first run. Saved profile
          changes apply only after explicitly restarting a conversation session.
        </p>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        {ACP_PROFILE_TEMPLATES.map((template) => (
          <button
            key={template.id}
            type="button"
            aria-label={`Add ${template.label} template`}
            onClick={() => addTemplate(template)}
            className="rounded-lg border border-border bg-base px-3 py-2 text-left transition-colors hover:border-border-strong hover:bg-hover"
          >
            <span className="block text-[0.857rem] font-medium text-text">
              {template.label}
            </span>
            <code className="mt-1 block break-all text-[0.714rem] text-text-dimmed">
              {[template.executable, ...template.args].join(" ")}
            </code>
          </button>
        ))}
      </div>

      <div className="mt-4 flex flex-col gap-4">
        {profiles.map((profile, profileIndex) => (
          <article
            key={profile.id}
            className="rounded-lg border border-border-subtle bg-base/50 p-4"
            aria-label={`${profile.name || `Profile ${profileIndex + 1}`} profile`}
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <label className="flex min-w-48 flex-1 flex-col gap-1 text-[0.714rem] font-medium text-text-muted">
                Profile name
                <input
                  aria-label="Profile name"
                  value={profile.name}
                  onChange={(event) =>
                    updateProfile(profile.id, (current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                  className="h-9 rounded-md border border-border bg-surface px-2.5 text-[0.857rem] text-text outline-none focus:border-accent"
                />
              </label>
              <div className="flex items-center gap-2 pt-5">
                <label className="flex items-center gap-1.5 text-[0.786rem] text-text-muted">
                  <input
                    type="radio"
                    name="default-acp-profile"
                    aria-label={`Default ${profile.name}`}
                    checked={defaultProfileId === profile.id}
                    disabled={profile.disabled}
                    onChange={() => setDefaultProfileId(profile.id)}
                  />
                  Default
                </label>
                <label className="flex items-center gap-1.5 text-[0.786rem] text-text-muted">
                  <input
                    type="checkbox"
                    aria-label={`Disable ${profile.name}`}
                    checked={Boolean(profile.disabled)}
                    onChange={(event) =>
                      setDisabled(profile.id, event.target.checked)
                    }
                  />
                  Disabled
                </label>
              </div>
            </div>

            <label className="mt-3 flex flex-col gap-1 text-[0.714rem] font-medium text-text-muted">
              Executable
              <input
                aria-label="Executable"
                value={profile.executable}
                onChange={(event) =>
                  updateProfile(profile.id, (current) => ({
                    ...current,
                    executable: event.target.value,
                  }))
                }
                className="h-9 rounded-md border border-border bg-surface px-2.5 font-mono text-[0.786rem] text-text outline-none focus:border-accent"
              />
            </label>

            <div className="mt-3">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[0.714rem] font-medium text-text-muted">
                  Literal arguments
                </span>
                <button
                  type="button"
                  aria-label={`Add argument for ${profile.name}`}
                  onClick={() =>
                    profile.args.length < MAX_ROWS &&
                    updateProfile(profile.id, (current) => ({
                      ...current,
                      args: [...current.args, ""],
                    }))
                  }
                  className="text-[0.714rem] text-accent hover:underline"
                >
                  Add argument
                </button>
              </div>
              <div className="flex flex-col gap-1.5">
                {profile.args.map((argument, index) => (
                  <div key={`${profile.id}-arg-${index}`} className="flex gap-1.5">
                    <input
                      aria-label={`Argument ${index + 1}`}
                      value={argument}
                      onChange={(event) =>
                        updateProfile(profile.id, (current) => ({
                          ...current,
                          args: current.args.map((value, candidateIndex) =>
                            candidateIndex === index ? event.target.value : value,
                          ),
                        }))
                      }
                      className="h-8 min-w-0 flex-1 rounded-md border border-border bg-surface px-2 font-mono text-[0.786rem] text-text outline-none focus:border-accent"
                    />
                    <button
                      type="button"
                      aria-label={`Remove argument ${index + 1} from ${profile.name}`}
                      onClick={() =>
                        updateProfile(profile.id, (current) => ({
                          ...current,
                          args: current.args.filter(
                            (_value, candidateIndex) => candidateIndex !== index,
                          ),
                        }))
                      }
                      className="rounded px-2 text-text-dimmed hover:bg-hover hover:text-text"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-3">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[0.714rem] font-medium text-text-muted">
                  Inherited environment names
                </span>
                <button
                  type="button"
                  aria-label={
                    profiles.length === 1
                      ? "Add environment name"
                      : `Add environment name for ${profile.name}`
                  }
                  onClick={() =>
                    profile.inheritEnv.length < MAX_ROWS &&
                    updateProfile(profile.id, (current) => ({
                      ...current,
                      inheritEnv: [...current.inheritEnv, ""],
                    }))
                  }
                  className="text-[0.714rem] text-accent hover:underline"
                >
                  Add name
                </button>
              </div>
              <div className="flex flex-col gap-1.5">
                {profile.inheritEnv.map((name, index) => (
                  <div key={`${profile.id}-env-${index}`} className="flex gap-1.5">
                    <input
                      aria-label={`Environment name ${index + 1}`}
                      placeholder="PATH"
                      value={name}
                      onChange={(event) =>
                        updateProfile(profile.id, (current) => ({
                          ...current,
                          inheritEnv: current.inheritEnv.map(
                            (value, candidateIndex) =>
                              candidateIndex === index
                                ? event.target.value
                                : value,
                          ),
                        }))
                      }
                      className="h-8 min-w-0 flex-1 rounded-md border border-border bg-surface px-2 font-mono text-[0.786rem] text-text outline-none focus:border-accent"
                    />
                    <button
                      type="button"
                      aria-label={`Remove environment name ${index + 1} from ${profile.name}`}
                      onClick={() =>
                        updateProfile(profile.id, (current) => ({
                          ...current,
                          inheritEnv: current.inheritEnv.filter(
                            (_value, candidateIndex) => candidateIndex !== index,
                          ),
                        }))
                      }
                      className="rounded px-2 text-text-dimmed hover:bg-hover hover:text-text"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-3 rounded border border-border-subtle bg-surface px-2.5 py-2 text-[0.714rem] text-text-dimmed">
              <span className="font-medium">Launch preview:</span>{" "}
              <code>{launchPreview(profile)}</code>
            </div>

            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                aria-label={`Duplicate ${profile.name}`}
                onClick={() => setDuplicateProfileId(profile.id)}
                className="rounded-md border border-border px-2.5 py-1.5 text-[0.786rem] text-text-muted hover:bg-hover hover:text-text"
              >
                Duplicate
              </button>
              <button
                type="button"
                aria-label={`Delete ${profile.name}`}
                onClick={() => deleteProfile(profile.id)}
                className="rounded-md border border-error/30 px-2.5 py-1.5 text-[0.786rem] text-error-bright hover:bg-error/10"
              >
                Delete
              </button>
            </div>
          </article>
        ))}
        {profiles.length === 0 && (
          <div className="rounded-lg border border-dashed border-border px-4 py-5 text-center text-[0.857rem] text-text-dimmed">
            Add a pinned template or create one by duplicating and editing a saved profile.
          </div>
        )}
      </div>

      {validationError && (
        <p role="alert" className="mt-3 text-[0.786rem] text-error-bright">
          {validationError}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-[0.786rem] text-error-bright">
          {error}
        </p>
      )}
      {saved && !validationError && !error && (
        <p role="status" className="mt-3 text-[0.786rem] text-success">
          Agent profiles saved.
        </p>
      )}
      {probeMessage && (
        <p role="status" className="mt-3 text-[0.786rem] text-success">
          {probeMessage}
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => void testDefaultProfile()}
          disabled={!saved || !defaultProfileId || Boolean(validationError) || testingProfile}
          title={saved ? "Launch the saved default profile and negotiate ACP v1" : "Save profile changes before testing"}
          className="rounded-lg border border-border px-4 py-2 text-[0.857rem] font-semibold text-text-secondary disabled:cursor-not-allowed disabled:opacity-45"
        >
          {testingProfile ? "Testing profile..." : "Test default profile"}
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!config || Boolean(validationError) || saving}
          className="rounded-lg bg-accent px-4 py-2 text-[0.857rem] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-45"
        >
          {saving ? "Saving agent profiles..." : "Save agent profiles"}
        </button>
      </div>

      {duplicateProfile && (
        <div
          role="alertdialog"
          aria-label={`Duplicate ${duplicateProfile.name}?`}
          className="mt-4 rounded-lg border border-warning/30 bg-warning-bg p-3"
        >
          <p className="text-[0.857rem] text-warning-text">
            Duplicate {duplicateProfile.name}? The copy is a separate trusted executable
            profile and will not become the default automatically.
          </p>
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setDuplicateProfileId(null)}
              className="rounded px-3 py-1.5 text-[0.786rem] text-text-muted hover:bg-hover"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmDuplicate}
              className="rounded bg-warning/20 px-3 py-1.5 text-[0.786rem] font-medium text-warning-text"
            >
              Confirm duplicate
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function validateProfiles(
  profiles: AcpProfile[],
  defaultProfileId: string | null,
): string | null {
  if (profiles.length > MAX_PROFILES) {
    return `A maximum of ${MAX_PROFILES} ACP profiles is supported.`;
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const profile of profiles) {
    if (!profile.id || ids.has(profile.id)) return "Every profile must have a unique ID.";
    ids.add(profile.id);
    const normalizedName = profile.name.trim().toLowerCase();
    if (!normalizedName) return "Profile name is required.";
    if (names.has(normalizedName)) return "Profile names must be unique.";
    names.add(normalizedName);
    if (!profile.executable.trim()) return `Executable is required for ${profile.name}.`;
    if (containsUnsafeControl(profile.executable)) {
      return `Executable for ${profile.name} contains an invalid control character.`;
    }
    if (profile.args.length > MAX_ROWS || profile.inheritEnv.length > MAX_ROWS) {
      return `${profile.name} has too many argument or environment rows.`;
    }
    if (profile.args.some(containsUnsafeControl)) {
      return `Arguments for ${profile.name} contain an invalid control character.`;
    }
    const envNames = profile.inheritEnv.map((name) => name.trim());
    if (envNames.some((name) => !ENV_NAME.test(name))) {
      return "Environment entries must be variable names only (for example PATH), never NAME=value or secret values.";
    }
    if (new Set(envNames).size !== envNames.length) {
      return `Inherited environment names for ${profile.name} must be unique.`;
    }
  }
  const enabled = profiles.filter((profile) => !profile.disabled);
  if (enabled.length === 0) {
    return profiles.length === 0 ? null : "Enable at least one agent profile or delete them all.";
  }
  if (
    !enabled.some((profile) => profile.id === defaultProfileId)
  ) {
    return "Choose an enabled default agent profile.";
  }
  if (
    defaultProfileId &&
    !enabled.some((profile) => profile.id === defaultProfileId)
  ) {
    return "The default agent profile must be enabled.";
  }
  return null;
}

function containsUnsafeControl(value: string) {
  return value.includes("\0") || value.includes("\n") || value.includes("\r");
}

function launchPreview(profile: AcpProfile) {
  return [profile.executable, ...profile.args]
    .map((part) => JSON.stringify(part))
    .join(" ");
}

function newProfileId(prefix: string) {
  const suffix =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${suffix}`;
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Could not load or save ACP profiles.";
}
