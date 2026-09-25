/** Minimal Markdown syntax-tree node, enough for text-rewriting remark plugins. */
export type MdNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
};

// Never rewrite inside links or code; code is not a text node anyway.
const SKIPPED = new Set(["link", "linkReference", "inlineCode", "code", "definition", "html"]);

/**
 * Replaces text nodes with the nodes `split` returns for them (or keeps them
 * when it returns null), walking the whole tree outside links and code.
 */
export function replaceTextNodes(node: MdNode, split: (value: string) => MdNode[] | null) {
  if (!node.children || SKIPPED.has(node.type)) return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && child.value) {
      next.push(...(split(child.value) ?? [child]));
    } else {
      replaceTextNodes(child, split);
      next.push(child);
    }
  }
  node.children = next;
}
