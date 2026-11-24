import { PlatformNotificationSettings as BrowserNotificationSettings } from "#platform-shell";
import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from "react";
import {
  SettingsFact,
  SettingsField,
  SettingsSection,
  settingsCard,
  settingsInlineButton,
  settingsInput,
  settingsPrimaryButton,
  settingsSecondaryButton,
  settingsQuietButton,
} from "../components/SettingsSection";
import { Avatar } from "../components/Avatar";
import { prepareProfilePicture } from "../lib/profile-picture";
import { useAuthStore } from "../stores/auth";
import { ApiAccessSettings } from "./settings-api-access";

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
  const [userIdCopied, setUserIdCopied] = useState(false);
  const [userIdCopyError, setUserIdCopyError] = useState<string | null>(null);
  const userIdCopyTimerRef = useRef<number | null>(null);


  useEffect(() => {
    setName(user?.name ?? "");
  }, [user?.name]);

  useEffect(() => {
    pictureOperationRef.current += 1;
    setPictureSaving(false);
    setPictureError(null);
    setPictureStatus(null);
    setUserIdCopied(false);
    setUserIdCopyError(null);
  }, [user?.id]);

  useEffect(
    () => () => {
      if (userIdCopyTimerRef.current !== null) {
        window.clearTimeout(userIdCopyTimerRef.current);
      }
    },
    [],
  );

  const copyUserId = async (userId: string) => {
    if (userIdCopyTimerRef.current !== null) {
      window.clearTimeout(userIdCopyTimerRef.current);
      userIdCopyTimerRef.current = null;
    }
    try {
      await navigator.clipboard.writeText(userId);
      setUserIdCopyError(null);
      setUserIdCopied(true);
      userIdCopyTimerRef.current = window.setTimeout(() => {
        userIdCopyTimerRef.current = null;
        setUserIdCopied(false);
      }, 1600);
    } catch {
      setUserIdCopied(false);
      setUserIdCopyError("Could not copy the user ID");
    }
  };

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
      className="flex h-full min-h-0 flex-col bg-base"
      aria-labelledby="settings-heading"
    >
      <header className="shrink-0 px-4 pb-4 pt-6 sm:px-8 sm:pt-8">
        <div className="mx-auto w-full max-w-[720px]">
          <h1
            id="settings-heading"
            className="text-[1.429rem] font-semibold tracking-tight text-text"
          >
            Settings
          </h1>
          <p className="mt-1 text-[0.929rem] text-text-muted">
            Manage your signed-in TheChat account.
          </p>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-10 pt-2 sm:px-8">
        <div className="mx-auto flex w-full max-w-[720px] min-w-0 flex-col gap-8">
          <SettingsSection id="profile-heading" title="Profile">
            {!user ? (
              <div className={settingsCard}>
                <div className="px-4 py-5 sm:px-5">
                  <p className="text-[0.929rem] font-medium text-text">
                    Sign in to view your profile
                  </p>
                  <p className="mt-1 text-[0.929rem] leading-5 text-text-muted">
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
                  <Avatar
                    aria-hidden="true"
                    name={user.name}
                    colorKey={user.id}
                    picture={user.avatar}
                    className="size-10 text-[0.929rem]"
                  />
                  <div className="min-w-0 truncate text-[1rem] font-medium text-text">
                    {user.name}
                  </div>
                </div>

                <SettingsField
                  label="Profile picture"
                  htmlFor="profile-picture"
                  hint="PNG, JPEG, or WebP, up to 10 MB. Resized before saving."
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <Avatar
                      aria-hidden="true"
                      name={user.name}
                      colorKey={user.id}
                      picture={user.avatar}
                      className="size-16 text-xl"
                    />
                    <label className={`${settingsSecondaryButton} relative focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent ${pictureSaving ? "cursor-wait opacity-55" : ""}`}>
                      <input
                        id="profile-picture"
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        aria-label="Choose profile picture"
                        className="sr-only"
                        disabled={pictureSaving}
                        onChange={handlePictureChange}
                      />
                      {pictureSaving ? "Saving picture..." : user.avatar ? "Change picture" : "Choose picture"}
                    </label>
                    {user.avatar && (
                      <button
                        type="button"
                        aria-label="Remove picture"
                        disabled={pictureSaving}
                        onClick={handlePictureRemove}
                        className={settingsQuietButton}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  {pictureError && <p className="mt-2 text-[0.929rem] text-error-bright" role="alert">{pictureError}</p>}
                  {pictureStatus && !pictureError && <p className="mt-2 text-[0.929rem] text-success-light" role="status">{pictureStatus}</p>}
                </SettingsField>

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
                  <SettingsFact
                    term="User ID"
                    mono
                    action={
                      <>
                        <button
                          type="button"
                          aria-label="Copy user ID"
                          className={settingsInlineButton}
                          onClick={() => void copyUserId(user.id)}
                        >
                          {userIdCopied ? "Copied" : "Copy"}
                        </button>
                        {userIdCopyError && (
                          <p
                            className="basis-full text-[0.857rem] leading-5 text-error-bright"
                            role="alert"
                          >
                            {userIdCopyError}
                          </p>
                        )}
                      </>
                    }
                  >
                    {user.id}
                  </SettingsFact>
                </dl>

                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5">
                  <div className="min-w-0 flex-1 text-[0.929rem] leading-5">
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
