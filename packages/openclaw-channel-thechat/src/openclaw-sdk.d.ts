// Ambient declarations so the entry-point and channel modules typecheck
// without the OpenClaw SDK being installed in the TheChat monorepo. When the
// plugin is installed alongside OpenClaw (`openclaw plugins install -l ...`),
// the real types from `openclaw/plugin-sdk/*` win because the real package
// gets resolved first.
//
// We deliberately use `any` here — pinning the surface tightly without the
// SDK present would force us to track upstream changes by hand.
declare module "openclaw/plugin-sdk/channel-core" {
  export const createChatChannelPlugin: any;
  export const buildChannelOutboundSessionRoute: any;
  export const buildThreadAwareOutboundSessionRoute: any;
  export const defineChannelPluginEntry: any;
  export const defineSetupPluginEntry: any;
  export type ChannelPlugin<T = unknown> = any;
  export type OpenClawConfig = any;
  export type OpenClawPluginApi = any;
}

declare module "openclaw/plugin-sdk/channel-entry-contract" {
  export const defineBundledChannelEntry: any;
  export const defineBundledChannelSetupEntry: any;
}
