import { isWeb } from "../../packages/client/src/platform/environment";
import * as desktop from "../../packages/desktop/src/platform/shell.desktop";
import * as web from "../../packages/web/src/platform/shell.web";
export function usePlatformLifecycle(token: string | null) {
  return (isWeb ? web : desktop).usePlatformLifecycle(token);
}
export const PlatformDialogs = () => isWeb ? <web.PlatformDialogs /> : <desktop.PlatformDialogs />;
export const PlatformTitlebar = () => isWeb ? <web.PlatformTitlebar /> : <desktop.PlatformTitlebar />;
export const PlatformSidebarUpdate = () => isWeb ? <web.PlatformSidebarUpdate /> : <desktop.PlatformSidebarUpdate />;
export const PlatformUpdateToast = () => isWeb ? <web.PlatformUpdateToast /> : <desktop.PlatformUpdateToast />;
export const PlatformNotificationSettings = () => isWeb ? <web.PlatformNotificationSettings /> : <desktop.PlatformNotificationSettings />;
