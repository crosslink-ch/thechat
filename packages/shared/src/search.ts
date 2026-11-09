/**
 * Matching shared by the API and the clients, so a name ranks the same way
 * whether it was found locally or by the server.
 */

/** Lower-case and strip diacritics: "Ribarić" and "ribaric" compare equal. */
export function foldSearchText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

const WORD_BOUNDARY = /[\s\-_./#@:()[\]]/;

/**
 * How well `query` names `text`, or null when it does not match at all.
 * Exact beats prefix beats word-start beats substring beats a subsequence
 * ("kda" finds "Koda"). Shorter names win ties within a tier.
 */
export function scoreSearchMatch(query: string, text: string): number | null {
  const q = foldSearchText(query).replace(/^[#@]/, "");
  const t = foldSearchText(text);
  if (!q) return 0;
  if (!t) return null;
  const lengthPenalty = Math.min(t.length - q.length, 30) / 100;
  if (t === q) return 100;
  if (t.startsWith(q)) return 80 - lengthPenalty;
  const index = t.indexOf(q);
  if (index > 0) {
    return (WORD_BOUNDARY.test(t[index - 1]!) ? 60 : 40) - lengthPenalty;
  }
  // Subsequence: every query character in order, fewer gaps rank higher.
  let position = -1;
  let gaps = 0;
  for (const char of q) {
    if (char === " ") continue;
    const next = t.indexOf(char, position + 1);
    if (next < 0) return null;
    if (position >= 0 && next > position + 1) gaps += 1;
    position = next;
  }
  return Math.max(1, 20 - gaps * 3) - lengthPenalty;
}

/**
 * Split a message query into the literal terms that must all appear.
 * Double quotes keep a phrase together: `"release notes" draft`.
 */
export function parseMessageSearchTerms(query: string) {
  const terms: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  for (const match of query.matchAll(pattern)) {
    const term = (match[1] ?? match[2] ?? "").replace(/\s+/g, " ").trim();
    if (term && !terms.some((existing) => existing.toLowerCase() === term.toLowerCase())) {
      terms.push(term);
    }
  }
  return terms;
}
