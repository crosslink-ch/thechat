import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Mention from "@tiptap/extension-mention";
import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { render } from "@testing-library/react";
import { Markdown } from "../components/Markdown";
import {
  composerFromText,
  composerToDocument,
  serializeComposer,
  type ComposerDocument,
} from "./composer-parts";

/**
 * Round trips through the real schema: Markdown -> editor document ->
 * Markdown must be the same text, and the editor must hold real blocks.
 */
const schema = getSchema([
  StarterKit.configure({ underline: false, link: { autolink: false, linkOnPaste: false } }),
  Mention,
]);

const ADA = "11111111-1111-4111-8111-111111111111";

const toDoc = (value: string | ComposerDocument) =>
  ProseMirrorNode.fromJSON(schema, composerToDocument(value));
const roundText = (markdown: string) => serializeComposer(toDoc(markdown)).text;
const blockTypes = (doc: ProseMirrorNode) => {
  const types: string[] = [];
  doc.forEach((block) => types.push(block.type.name));
  return types;
};

const FIXTURES: Record<string, string> = {
  "plain lines": "first line\nsecond line\n\nafter a blank line",
  "bullet list": "Todo:\n\n- one\n- two",
  "nested lists": "- fruit\n  - apple\n  - pear\n    1. ripe\n    2. green\n- veg",
  "list item with two lines": "- first line\n  second line\n- next",
  "empty list item draft": "- a\n-",
  "numbered list from 3": "3. third\n4. fourth",
  "quote with lines": "> quoted\n> second quoted line",
  // A line inside the code starts with a fence, so the block needs a longer one.
  "code with backticks": "````md\n```ts\nconst x = `a`;\n```\n````",
  "code with blank lines": "```\na\n\n\nb\n```",
  heading: "## Plan\n\nThen the details",
  divider: "above\n\n---\n\nbelow",
  marks: "**bold** *italic* ~~gone~~ `code` and ***both***",
  unicode: "Zoë 🧪 👋🏽 e\u0301 — مرحبا 日本語",
  "blocks after text": "Intro\n\n- a\n\n> q\n\n```\nx\n```\n\nOutro",
  // Block markers need escapes only at the start of a line.
  "escaped literal text":
    "2\\*3 = 6, a_b_c, \\_x\\_, [link](https://example.com) <b>html</b> \\&amp; \\\\\\* - # 1. > \\`\n\\- a\n\\# b\n1\\. c\n\\> d\n\\+ e\n\\---\n\\===",
  "kept source": "see https://e.com/__init__.py, [a *b*](https://e.com/?a=1&b=2) <https://e.com> $$x_1*y_2$$",
};

/**
 * Markdown the composer did not write (plain text, older drafts) is read
 * once into the editor; what the editor shows is then written with escapes,
 * and that output is stable.
 */
const NORMALIZED: Record<string, [string, string]> = {
  "unescaped literal characters": [
    "2*3 = 6, a_b_c, [x] &amp; \\*",
    "2\\*3 = 6, a_b_c, \\[x] \\&amp; \\*",
  ],
  "underscore emphasis becomes stars": ["_x_ and __y__", "*x* and **y**"],
};

describe("composer Markdown round trip", () => {
  it.each(Object.entries(FIXTURES))("%s", (_name, markdown) => {
    const text = roundText(markdown);
    expect(text).toBe(markdown);
    // Stable: a restored draft serializes to the same text again.
    expect(roundText(text)).toBe(markdown);
  });

  it.each(Object.entries(NORMALIZED))("%s", (_name, [input, output]) => {
    expect(roundText(input)).toBe(output);
    expect(roundText(output)).toBe(output);
  });

  it("holds real blocks, not literal Markdown", () => {
    const doc = toDoc("Intro\n\n- a\n\n> q\n\n```\nx\n```\n\n## H\n\n---\n\n1. n");
    expect(blockTypes(doc)).toEqual([
      "paragraph", "bulletList", "blockquote", "codeBlock", "heading", "horizontalRule", "orderedList",
    ]);
    const nested = toDoc(FIXTURES["nested lists"]!);
    expect(nested.firstChild!.firstChild!.childCount).toBe(2);
    expect(nested.firstChild!.firstChild!.child(1).type.name).toBe("bulletList");
  });

  it("keeps a mention inside bold and inside a list item by ID", () => {
    const draft: ComposerDocument = {
      text: "",
      labels: { [ADA]: "Ada" },
      parts: [
        { type: "text", text: "**Hi " },
        { type: "reference", refType: "user", refId: ADA },
        { type: "text", text: " today**\n\n- ask " },
        { type: "reference", refType: "user", refId: ADA },
      ],
    };
    const doc = toDoc(draft);
    const mentions: { marks: string[] }[] = [];
    doc.descendants((node) => {
      if (node.type.name === "mention") {
        expect(node.attrs.id).toBe(ADA);
        mentions.push({ marks: node.marks.map((mark) => mark.type.name) });
      }
    });
    expect(mentions).toEqual([{ marks: ["bold"] }, { marks: [] }]);
    const result = serializeComposer(doc);
    expect(result.parts).toEqual(draft.parts);
    expect(result.text).toBe("**Hi @Ada today**\n\n- ask @Ada");
  });

  it("keeps a mention in code as readable text", () => {
    const doc = toDoc({
      text: "",
      labels: { [ADA]: "Ada" },
      parts: [{ type: "text", text: "```\nping " }, { type: "reference", refType: "user", refId: ADA }, { type: "text", text: "\n```" }],
    });
    expect(doc.firstChild!.type.name).toBe("codeBlock");
    expect(doc.firstChild!.textContent).toBe("ping @Ada");
  });

  it("cannot forge a reference with private-use characters", () => {
    const doc = toDoc(composerFromText("x \uE0020\uE003 y"));
    let mentions = 0;
    doc.descendants((node) => {
      if (node.type.name === "mention") mentions += 1;
    });
    expect(mentions).toBe(0);
    expect(serializeComposer(doc).parts.every((part) => part.type === "text")).toBe(true);
  });

  it("renders the sent Markdown with the same blocks the composer showed", () => {
    const markdown = "Plan:\n\n- **ship** it\n- test\n\n```js\nconst a = 1;\n```\n\n> done";
    const sent = serializeComposer(toDoc(markdown)).text;
    const { container } = render(<Markdown content={sent} />);
    expect(container.querySelectorAll("ul > li")).toHaveLength(2);
    expect(container.querySelector("li strong")?.textContent).toBe("ship");
    expect(container.querySelector("pre code")?.textContent).toContain("const a = 1;");
    expect(container.querySelector("blockquote")?.textContent?.trim()).toBe("done");
  });
});
