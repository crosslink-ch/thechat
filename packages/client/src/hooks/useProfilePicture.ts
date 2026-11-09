import { useAuthStore } from "../stores/auth";
import { useKnownProfilePicture } from "../stores/profile-pictures";

/** Current picture for an authorized person, independent of sidebar selection. */
export function useProfilePicture(
  userId: string | null | undefined,
  fallback: string | null = null,
) {
  const ownPicture = useAuthStore((state) =>
    userId && state.user?.id === userId ? state.user.avatar : undefined,
  );
  const knownPicture = useKnownProfilePicture(userId);
  return ownPicture !== undefined ? ownPicture
    : knownPicture !== undefined ? knownPicture : fallback;
}
