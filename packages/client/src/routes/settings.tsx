import { PlatformNotificationSettings as BrowserNotificationSettings } from "#platform-shell";
import { type FormEvent, useEffect, useState } from "react";
import {
  SettingsFact,
  SettingsField,
  SettingsSection,
  settingsCard,
  settingsInput,
  settingsPrimaryButton,
} from "../components/SettingsSection";
import { useAuthStore } from "../stores/auth";
import { ApiAccessSettings } from "./settings-api-access";

function getInitials(name: string) {
  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0))
    .join("")
    .toUpperCase();

  return initials || "?";
}

export function SettingsRoute() {
  const user = useAuthStore((state) => state.user);
  const updateName = useAuthStore((state) => state.updateName);
  const [name, setName] = useState(user?.name ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setName(user?.name ?? "");
  }, [user?.name]);

  const trimmedName = name.trim();
  const canSave = Boolean(
    user && trimmedName && trimmedName !== user.name && !saving,
  );

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!user || saving) return;
    if (!trimmedName) {
      setError("Name is required");
      setSaved(false);
      return;
    }
    if (trimmedName.length > 255) {
      setError("Name must be 255 characters or fewer");
      setSaved(false);
      return;
    }
    if (trimmedName === user.name) return;

    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await updateName(trimmedName);
      setSaved(true);
    } catch (updateError) {
      setError(
        updateError instanceof Error
          ? updateError.message
          : "Could not update profile",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <main
      className="flex h-full min-h-0 flex-col bg-base"
      aria-labelledby="settings-heading"
    >
      <header className="shrink-0 border-b border-border px-5 py-4">
        <h1
          id="settings-heading"
          className="text-[1.071rem] font-semibold text-text"
        >
          Settings
        </h1>
        <p className="mt-1 text-[0.786rem] text-text-muted">
          Manage your signed-in TheChat account.
        </p>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 sm:py-8">
        <div className="mx-auto flex w-full max-w-[720px] min-w-0 flex-col gap-8">
          <SettingsSection id="profile-heading" title="Profile">
            {!user ? (
              <div className={settingsCard}>
                <div className="px-4 py-5 sm:px-5">
                  <p className="text-[0.929rem] font-medium text-text">
                    Sign in to view your profile
                  </p>
                  <p className="mt-1 text-[0.857rem] leading-5 text-text-muted">
                    Your account details will appear here after authentication
                    finishes.
                  </p>
                </div>
              </div>
            ) : (
              <form
                className={settingsCard}
                aria-label="Profile settings"
                onSubmit={handleSubmit}
              >
                <div className="flex min-w-0 items-center gap-3 px-4 py-4 sm:px-5">
                  <div
                    aria-hidden="true"
                    className="flex size-10 shrink-0 items-center justify-center rounded-full bg-elevated text-[0.857rem] font-semibold text-text-secondary"
                  >
                    {getInitials(user.name)}
                  </div>
                  <div className="min-w-0 truncate text-[0.929rem] font-medium text-text">
                    {user.name}
                  </div>
                </div>

                <SettingsField label="Name" htmlFor="profile-name">
                  <input
                    id="profile-name"
                    value={name}
                    onChange={(event) => {
                      setName(event.target.value);
                      setError(null);
                      setSaved(false);
                    }}
                    autoComplete="name"
                    maxLength={255}
                    required
                    disabled={saving}
                    aria-invalid={error ? "true" : undefined}
                    className={settingsInput}
                  />
                </SettingsField>

                <dl
                  className="divide-y divide-border-subtle"
                  aria-label="Account information"
                >
                  <SettingsFact term="Email address" hint="Read only">
                    {user.email ?? "No email address"}
                  </SettingsFact>
                  <SettingsFact term="User ID" mono>
                    {user.id}
                  </SettingsFact>
                </dl>

                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
                  <div className="min-w-0 flex-1 text-[0.857rem] leading-5">
                    {error && (
                      <p className="text-error-bright" role="alert">
                        {error}
                      </p>
                    )}
                    {saved && !error && (
                      <p className="text-success-light" role="status">
                        Name saved.
                      </p>
                    )}
                  </div>
                  <button
                    type="submit"
                    disabled={!canSave}
                    className={settingsPrimaryButton}
                  >
                    {saving ? "Saving..." : "Save name"}
                  </button>
                </div>
              </form>
            )}
          </SettingsSection>

          {user && (
            <>
              <BrowserNotificationSettings />
              <ApiAccessSettings key={user.id} />
            </>
          )}
        </div>
      </div>
    </main>
  );
}
