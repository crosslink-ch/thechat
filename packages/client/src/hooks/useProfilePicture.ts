import type { WorkspaceMember } from "@thechat/shared";
import { useAuthStore } from "../stores/auth";
import { useWorkspacesStore } from "../stores/workspaces";

// One lookup per member list, shared by every row that reads it; the store
// replaces the list on change, so a stale map is never reused.
const picturesByMembers = new WeakMap<WorkspaceMember[], Map<string, string>>();

function profilePicturesOf(members: WorkspaceMember[]) {
  let pictures = picturesByMembers.get(members);
  if (!pictures) {
    pictures = new Map();
    for (const member of members) {
      if (member.user.type === "human" && member.user.avatar) {
        pictures.set(member.userId, member.user.avatar);
      }
    }
    picturesByMembers.set(members, pictures);
  }
  return pictures;
}

/**
 * A person's profile picture by their user id: the signed-in user's own, or
 * the one in the active workspace's members, so a change shows on every
 * earlier message too. Null when they have none or are not a member here.
 */
export function useProfilePicture(userId: string | null | undefined) {
  const ownPicture = useAuthStore((state) =>
    userId && state.user?.id === userId ? state.user.avatar : undefined,
  );
  const memberPicture = useWorkspacesStore((state) => {
    const members = state.activeWorkspace?.members;
    return userId && members ? profilePicturesOf(members).get(userId) : undefined;
  });
  return ownPicture !== undefined ? ownPicture : (memberPicture ?? null);
}
