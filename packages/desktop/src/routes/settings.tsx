import {
  type ChangeEvent,
  type FormEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { UserAvatar } from "../components/UserAvatar";
import { prepareProfilePicture } from "../lib/profile-picture";
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

export function SettingsRoute() {
  const user = useAuthStore((state) => state.user);
  const updateName = useAuthStore((state) => state.updateName);
  const updateAvatar = useAuthStore((state) => state.updateAvatar);
  const [name, setName] = useState(user?.name ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pictureSaving, setPictureSaving] = useState(false);
  const [pictureError, setPictureError] = useState<string | null>(null);
  const [pictureStatus, setPictureStatus] = useState<string | null>(null);
  const pictureOperationRef = useRef(0);

  useEffect(() => {
    setName(user?.name ?? "");
  }, [user?.name]);

  useEffect(() => {
    pictureOperationRef.current += 1;
    setPictureSaving(false);
    setPictureError(null);
    setPictureStatus(null);
  }, [user?.id]);

  const isCurrentPictureOperation = (operation: number, userId: string) =>
    pictureOperationRef.current === operation &&
    useAuthStore.getState().user?.id === userId;

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

  const handlePictureChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    const userId = user?.id;
    if (!file || !userId || pictureSaving) return;

    const operation = ++pictureOperationRef.current;
    setPictureSaving(true);
    setPictureError(null);
    setPictureStatus(null);
    try {
      const avatar = await prepareProfilePicture(file);
      if (!isCurrentPictureOperation(operation, userId)) return;
      await updateAvatar(avatar);
      if (isCurrentPictureOperation(operation, userId)) {
        setPictureStatus("Profile picture saved.");
      }
    } catch (pictureUpdateError) {
      if (isCurrentPictureOperation(operation, userId)) {
        setPictureError(
          pictureUpdateError instanceof Error
            ? pictureUpdateError.message
            : "Could not update profile picture",
        );
      }
    } finally {
      if (isCurrentPictureOperation(operation, userId)) {
        setPictureSaving(false);
      }
    }
  };

  const handlePictureRemove = async () => {
    const userId = user?.id;
    if (!userId || !user.avatar || pictureSaving) return;

    const operation = ++pictureOperationRef.current;
    setPictureSaving(true);
    setPictureError(null);
    setPictureStatus(null);
    try {
      await updateAvatar(null);
      if (isCurrentPictureOperation(operation, userId)) {
        setPictureStatus("Profile picture removed.");
      }
    } catch (pictureUpdateError) {
      if (isCurrentPictureOperation(operation, userId)) {
        setPictureError(
          pictureUpdateError instanceof Error
            ? pictureUpdateError.message
            : "Could not remove profile picture",
        );
      }
    } finally {
      if (isCurrentPictureOperation(operation, userId)) {
        setPictureSaving(false);
      }
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
                <UserAvatar
                  name={user.name}
                  avatar={user.avatar}
                  size="lg"
                  className="shadow-sm"
                />
                <div className="truncate text-[1rem] font-semibold text-text">
                  {user.name}
                </div>
              </div>
            </div>

            <div className="p-5 sm:p-6">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                <UserAvatar
                  name={user.name}
                  avatar={user.avatar}
                  size="xl"
                  className="ring-1 ring-border-subtle shadow-sm"
                />
                <div className="min-w-0 flex-1">
                  <div className="text-[0.857rem] font-semibold text-text">
                    Profile picture
                  </div>
                  <p className="mt-1 text-[0.786rem] leading-5 text-text-muted">
                    PNG, JPEG, or WebP. Images are resized before they are saved.
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <label
                      className={`inline-flex h-9 items-center justify-center rounded-lg border border-border bg-raised px-3.5 text-[0.786rem] font-semibold text-text transition-colors ${
                        pictureSaving
                          ? "cursor-wait opacity-55"
                          : "cursor-pointer hover:bg-hover"
                      }`}
                    >
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        aria-label="Choose profile picture"
                        className="sr-only"
                        disabled={pictureSaving}
                        onChange={handlePictureChange}
                      />
                      {pictureSaving
                        ? "Saving picture..."
                        : user.avatar
                          ? "Change picture"
                          : "Choose picture"}
                    </label>
                    {user.avatar && (
                      <button
                        type="button"
                        aria-label="Remove picture"
                        disabled={pictureSaving}
                        onClick={handlePictureRemove}
                        className="inline-flex h-9 cursor-pointer items-center justify-center rounded-lg px-3 text-[0.786rem] font-medium text-text-muted transition-colors hover:bg-hover hover:text-text disabled:cursor-wait disabled:opacity-55"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  {pictureError && (
                    <p className="mt-2 text-[0.786rem] text-red-400" role="alert">
                      {pictureError}
                    </p>
                  )}
                  {pictureStatus && !pictureError && (
                    <p
                      className="mt-2 text-[0.786rem] text-emerald-400"
                      role="status"
                    >
                      {pictureStatus}
                    </p>
                  )}
                </div>
              </div>

              <div className="mt-6 flex min-w-0 flex-col gap-2 border-t border-border-subtle pt-5">
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
