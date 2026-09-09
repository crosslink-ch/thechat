declare module "#platform-services" {
  export const services: import("./contracts").PlatformServices;
}
declare module "#platform-shell" {
  export const usePlatformLifecycle: import("./contracts").PlatformShell["usePlatformLifecycle"];
  export const PlatformDialogs: import("./contracts").PlatformShell["PlatformDialogs"];
  export const PlatformTitlebar: import("./contracts").PlatformShell["PlatformTitlebar"];
  export const PlatformUpdateToast: import("./contracts").PlatformShell["PlatformUpdateToast"];
  export const PlatformNotificationSettings: import("./contracts").PlatformShell["PlatformNotificationSettings"];
}
