import { replaceTextNodes, type MdNode } from "./mdast-text";

/**
 * Mentions are stored as plain "@Display Name" text (see RichInput), so they
 * are recognised by matching the names of people and bots in the workspace.
 */
export interface MentionNames {
  /** Other members and bots. */
  names: string[];
  /** The signed-in user's name, highlighted differently. */
  self: string | null;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Longest names first, so "@Razvan Cuceu" wins over a member called "Razvan". */
function mentionPattern(names: string[], flags: string): RegExp | null {
  const unique = [...new Set(names.map((name) => name.trim()).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  if (unique.length === 0) return null;
  // Not after word characters, "." or "@" (emails); not followed by a word character.
  return new RegExp(`(^|[^\\w.@])@(${unique.map(escapeRegExp).join("|")})(?!\\w)`, flags);
}

export function remarkMentions({ names, self }: MentionNames) {
  const pattern = mentionPattern(self ? [...names, self] : names, "gi");
  const selfName = self?.trim().toLowerCase();

  return (tree: MdNode) => {
    if (!pattern) return;
    replaceTextNodes(tree, (value) => {
      const nodes: MdNode[] = [];
      let last = 0;
      for (const match of value.matchAll(pattern)) {
        const start = (match.index ?? 0) + match[1].length;
        const text = `@${match[2]}`;
        if (start > last) nodes.push({ type: "text", value: value.slice(last, start) });
        const isSelf = match[2].toLowerCase() === selfName;
        nodes.push({
          type: "mention",
          data: {
            hName: "span",
            hProperties: {
              className: isSelf ? ["md-mention", "md-mention-self"] : ["md-mention"],
            },
          },
          children: [{ type: "text", value: text }],
        });
        last = start + text.length;
      }
      if (last === 0) return null;
      if (last < value.length) nodes.push({ type: "text", value: value.slice(last) });
      return nodes;
    });
  };
}

/** True when `content` mentions `name`, e.g. to highlight messages mentioning you. */
export function mentionsName(content: string, name: string | null | undefined) {
  if (!name || !content.includes("@")) return false;
  return mentionPattern([name], "i")?.test(content) ?? false;
}
