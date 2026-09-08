import { services } from "#platform-services";
export type { PreferenceKey } from "./contracts";
/** UI-only preferences, deliberately separate from credential storage. */
export const preferences = services.preferences;
