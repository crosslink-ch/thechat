import { type FormEvent, useEffect, useState } from "react";
import { useAuthStore } from "../stores/auth";
import { ApiAccessSettings } from "./settings-api-access";

function LockIcon() {
  return (
    <svg
      aria-hidden="true"
      width="13"
      height="13"
      viewBox="0 0 13 13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2.25" y="5.5" width="8.5" height="6" rx="1.4" />
      <path d="M4.2 5.5V4.1a2.3 2.3 0 0 1 4.6 0v1.4" />
    </svg>
  );
}

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
      className="h-full overflow-y-auto bg-base px-4 py-6 sm:px-7 sm:py-8"
      aria-labelledby="profile-heading"
    >
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-6">
        <header className="flex flex-col gap-2">
          <div className="text-[0.714rem] font-semibold uppercase tracking-[0.16em] text-accent">
            Account
          </div>
          <h1
            id="profile-heading"
            className="text-[1.7rem] font-semibold tracking-[-0.03em] text-text"
          >
            Profile
          </h1>
          <p className="max-w-[560px] text-[0.929rem] leading-6 text-text-muted">
            Manage the profile associated with your signed-in TheChat account.
          </p>
        </header>

        {!user ? (
          <section className="rounded-xl border border-border-subtle bg-surface p-5 shadow-sm sm:p-6">
            <h2 className="text-[1rem] font-semibold text-text">
              Sign in to view your profile
            </h2>
            <p className="mt-2 text-[0.857rem] leading-5 text-text-muted">
              Your account details will appear here after authentication finishes.
            </p>
          </section>
        ) : (
          <>
          <form
            className="overflow-hidden rounded-xl border border-border-subtle bg-surface shadow-sm"
            aria-label="Profile settings"
            onSubmit={handleSubmit}
          >
            <div className="border-b border-border-subtle bg-gradient-to-br from-accent/[0.12] via-surface to-surface p-5 sm:p-6">
              <div className="flex min-w-0 items-center gap-3.5">
                <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent text-[0.929rem] font-semibold text-white shadow-sm">
                  {getInitials(user.name)}
                </div>
                <div className="truncate text-[1rem] font-semibold text-text">
                  {user.name}
                </div>
              </div>
            </div>

            <div className="p-5 sm:p-6">
              <div className="flex min-w-0 flex-col gap-2">
                <label
                  htmlFor="profile-name"
                  className="text-[0.786rem] font-medium text-text-muted"
                >
                  Name
                </label>
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
                  className="h-10 w-full min-w-0 rounded-lg border border-border-subtle bg-base px-3 text-[0.929rem] text-text outline-none transition-colors focus:border-accent disabled:cursor-wait disabled:opacity-70"
                />
              </div>

              <dl
                className="mt-5 overflow-hidden rounded-lg border border-border-subtle bg-base/60"
                aria-label="Account information"
              >
                <div className="min-w-0 px-3.5 py-3">
                  <dt className="flex items-center justify-between gap-4">
                    <span className="text-[0.714rem] font-medium uppercase tracking-[0.08em] text-text-dimmed">
                      Email address
                    </span>
                    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-[0.714rem] font-medium text-text-dimmed">
                      <LockIcon />
                      Read only
                    </span>
                  </dt>
                  <dd className="mt-1 break-all text-[0.857rem] text-text-muted">
                    {user.email ?? "No email address"}
                  </dd>
                </div>
                <div className="border-t border-border-subtle px-3.5 py-3">
                  <dt className="text-[0.714rem] font-medium uppercase tracking-[0.08em] text-text-dimmed">
                    User ID
                  </dt>
                  <dd className="mt-1 break-all font-mono text-[0.786rem] text-text-muted">
                    {user.id}
                  </dd>
                </div>
              </dl>
            </div>

            <div className="flex flex-col gap-3 border-t border-border-subtle px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
              <div className="min-w-0 sm:mr-auto">
                {error && (
                  <p className="text-[0.786rem] text-red-400" role="alert">
                    {error}
                  </p>
                )}
                {saved && !error && (
                  <p
                    className="text-[0.786rem] text-emerald-400"
                    role="status"
                  >
                    Name saved.
                  </p>
                )}
              </div>
              <button
                type="submit"
                disabled={!canSave}
                className="inline-flex h-9 shrink-0 items-center justify-center rounded-lg bg-accent px-4 text-[0.857rem] font-semibold text-white transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-45"
              >
                {saving ? "Saving..." : "Save name"}
              </button>
            </div>
          </form>
          <ApiAccessSettings key={user.id} />
          </>
        )}
      </div>
    </main>
  );
}
