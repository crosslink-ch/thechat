// Ambient declarations so the entry-point file typechecks without the
// OpenClaw SDK being installed in the TheChat monorepo. When the plugin is
// installed alongside OpenClaw, the real types from
// `openclaw/plugin-sdk/*` win because the real package gets resolved first.
//
// We deliberately use `any` here — pinning the surface tightly without the
// SDK present would force us to track upstream changes by hand.
declare module "openclaw/plugin-sdk/channel-core" {
  export const createChatChannelPlugin: any;
  export const buildChannelOutboundSessionRoute: any;
  export const defineChannelPluginEntry: any;
}

declare module "openclaw/plugin-sdk/channel-entry-contract" {
  export const defineBundledChannelEntry: any;
}
