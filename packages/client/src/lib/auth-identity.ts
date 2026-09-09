import { isWeb } from "../platform/environment";
import { useAuthStore } from "../stores/auth";

/** Request eligibility, not a credential: browser sessions have no JS bearer. */
export function isAuthenticated(token: string | null | undefined) {
  return isWeb ? Boolean(useAuthStore.getState().user) : Boolean(token);
}
