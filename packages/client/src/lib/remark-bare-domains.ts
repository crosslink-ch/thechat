/**
 * Links bare domains such as "brunos.ch" or "example.com/pricing", which GFM
 * only autolinks when they start with "www." or a scheme.
 *
 * Only common web endings count: many file extensions are also real country
 * domains (README.md, main.py, run.sh, lib.rs), so those stay plain text.
 * Code is never touched because it is not a text node.
 */

import { replaceTextNodes, type MdNode } from "./mdast-text";

const WEB_ENDINGS = [
  "com", "net", "org", "info", "biz", "io", "co", "ai", "app", "dev", "me", "tv",
  "cloud", "tech", "online", "site", "website", "shop", "store", "blog", "news",
  "agency", "digital", "design", "studio", "page", "swiss", "zurich",
  "ch", "li", "de", "at", "fr", "it", "es", "pt", "nl", "be", "lu", "uk", "eu", "ie",
  "se", "dk", "fi", "cz", "us", "ca", "au", "nz", "jp", "br", "mx",
];

// A boundary (not after word characters, "@", "/", "." or "-", which rules out
// emails, paths and file names), labels, a known ending, then optional
// port/path. The boundary is captured rather than a lookbehind, which older
// macOS web views cannot parse.
const BARE_DOMAIN = new RegExp(
  String.raw`(^|[^\w@/.\-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:${WEB_ENDINGS.join("|")})(?![\w-])(?::\d{2,5})?(?:[/?#][^\s<>"'\x60]*)?)`,
  "gi",
);
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

export function remarkBareDomains() {
  return (tree: MdNode) => replaceTextNodes(tree, linkText);
}

function linkText(value: string): MdNode[] | null {
  const nodes: MdNode[] = [];
  let last = 0;
  for (const match of value.matchAll(BARE_DOMAIN)) {
    const start = (match.index ?? 0) + match[1].length;
    let text = match[2];
    const trailing = TRAILING_PUNCTUATION.exec(text)?.[0] ?? "";
    text = text.slice(0, text.length - trailing.length);
    if (start > last) nodes.push({ type: "text", value: value.slice(last, start) });
    nodes.push({
      type: "link",
      url: `https://${text}`,
      children: [{ type: "text", value: text }],
    });
    last = start + text.length;
  }
  if (last === 0) return null;
  if (last < value.length) nodes.push({ type: "text", value: value.slice(last) });
  return nodes;
}
