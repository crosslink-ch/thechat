/**
 * Whether quoted text really comes from a message, so bots may attribute the
 * quote to that message's author.
 *
 * Clients quote what the reader saw: rendered markdown, not its source. Both
 * sides are therefore compared as sequences of words, which drops markdown
 * syntax, punctuation and whitespace. Link targets, image markup and reference
 * definitions are removed from the source first because they are not visible
 * text. A false negative only loses attribution; the reply is still sent.
 */
export function quoteMatchesSource(quote: string, source: string): boolean {
  const quoted = words(quote.replace(/…$/u, ""));
  const visible = visibleMarkdownText(source);
  if (quoted.length === 0) {
    const compact = (value: string) => value.replace(/\s+/gu, "");
    const needle = compact(quote.replace(/…$/u, ""));
    return needle.length > 0 && compact(visible).includes(needle);
  }
  return containsRun(words(visible), quoted);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function visibleMarkdownText(source: string): string {
  return source
    .replace(/^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*\S.*$/gmu, " ")
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/gu, " ")
    .replace(/\]\((?:[^()\s]|\([^()\s]*\))*(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\)/gu, "]")
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/giu, (entity, name: string) => {
      const lower = name.toLowerCase();
      if (lower.startsWith("#x")) return safeCodePoint(parseInt(lower.slice(2), 16), entity);
      if (lower.startsWith("#")) return safeCodePoint(parseInt(lower.slice(1), 10), entity);
      return NAMED_ENTITIES[lower] ?? entity;
    });
}

function safeCodePoint(value: number, fallback: string) {
  return Number.isInteger(value) && value > 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : fallback;
}

function words(text: string): string[] {
  return text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function containsRun(haystack: string[], needle: string[]): boolean {
  outer: for (let start = 0; start + needle.length <= haystack.length; start++) {
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[start + offset] !== needle[offset]) continue outer;
    }
    return true;
  }
  return false;
}
