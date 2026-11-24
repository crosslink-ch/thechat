/**
 * Channel names. A channel has two: its title as typed ("My Channel"), which
 * is what people see, and its slug ("my-channel"), the unique, URL-safe name
 * that bots, payloads and the API keep using.
 */

export interface ChannelNaming {
  /** The unique slug: "my-channel". */
  name: string | null | undefined;
  /** The name as typed: "My Channel". Null on channels made before titles. */
  title?: string | null;
}

/**
 * The title kept for a name as typed: runs of whitespace collapsed, and no
 * leading "#". The sidebar and header already put a # in front of a channel,
 * so "#ops" typed by habit would otherwise show as "##ops".
 */
export function normalizeChannelTitle(value: string): string {
  return value.replace(/\s+/g, " ").replace(/^[\s#]+/, "").trim();
}

/**
 * What people see for a channel: its title, or its slug when it has none.
 * Channels created in lowercase have a title equal to their slug, so they
 * look as they always did until someone renames them.
 */
export function channelDisplayName(channel: ChannelNaming, fallback = "channel"): string {
  return shownTitle(channel) || channel.name?.trim() || fallback;
}

/** Every name a channel can be found by: its title and its slug. */
export function channelSearchNames(channel: ChannelNaming): string[] {
  const names = [shownTitle(channel), channel.name?.trim()].filter(
    (name): name is string => Boolean(name),
  );
  return [...new Set(names)];
}

function shownTitle(channel: ChannelNaming) {
  return channel.title ? normalizeChannelTitle(channel.title) : "";
}
