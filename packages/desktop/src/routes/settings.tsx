import { useAuthStore } from "../stores/auth";

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
            View the identity associated with your signed-in TheChat account.
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
          <section className="overflow-hidden rounded-xl border border-border-subtle bg-surface shadow-sm">
            <div className="flex flex-col gap-4 border-b border-border-subtle bg-gradient-to-br from-accent/[0.12] via-surface to-surface p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
              <div className="flex min-w-0 items-center gap-3.5">
                <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent text-[0.929rem] font-semibold text-white shadow-sm">
                  {getInitials(user.name)}
                </div>
                <div className="min-w-0">
                  <div className="truncate text-[1rem] font-semibold text-text">
                    {user.name}
                  </div>
                  <div className="truncate text-[0.857rem] text-text-muted">
                    {user.email ?? "No email address"}
                  </div>
                </div>
              </div>
              <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-border bg-base/70 px-2.5 py-1 text-[0.714rem] font-medium text-text-muted">
                <LockIcon />
                Read-only
              </span>
            </div>

            <div className="grid gap-5 p-5 sm:grid-cols-2 sm:p-6">
              <div className="flex min-w-0 flex-col gap-2">
                <label
                  htmlFor="profile-name"
                  className="text-[0.786rem] font-medium text-text-muted"
                >
                  Name
                </label>
                <input
                  id="profile-name"
                  value={user.name}
                  readOnly
                  aria-readonly="true"
                  className="h-10 w-full min-w-0 cursor-default rounded-lg border border-border-subtle bg-base px-3 text-[0.929rem] text-text outline-none"
                />
              </div>

              <div className="flex min-w-0 flex-col gap-2">
                <label
                  htmlFor="profile-email"
                  className="text-[0.786rem] font-medium text-text-muted"
                >
                  Email address
                </label>
                <input
                  id="profile-email"
                  type="email"
                  value={user.email ?? ""}
                  placeholder="No email address"
                  readOnly
                  aria-readonly="true"
                  className="h-10 w-full min-w-0 cursor-default rounded-lg border border-border-subtle bg-base px-3 text-[0.929rem] text-text outline-none placeholder:text-text-dimmed"
                />
              </div>
            </div>

            <div className="border-t border-border-subtle px-5 py-4 sm:px-6">
              <p className="flex items-start gap-2 text-[0.786rem] leading-5 text-text-dimmed">
                <span className="mt-0.5 shrink-0 text-text-muted">
                  <LockIcon />
                </span>
                Profile editing is not available in TheChat yet. These details come from your signed-in account.
              </p>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
