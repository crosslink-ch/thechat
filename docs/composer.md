# Message composer

The composer formats while you type. Messages are still stored and sent as
Markdown, so what the composer shows is what the sent message renders.

## Typing

| Type | Becomes |
| --- | --- |
| `- ` or `* ` | bullet list |
| `1. ` | numbered list |
| `> ` | quote |
| ```` ``` ```` then space | code block |
| `# `, `## `, `### ` | heading |
| `---` | divider |
| `**bold**`, `*italic*`, `~~strike~~`, `` `code` `` | the mark |

Links, HTML and entities stay visible as their source text, like pasted
links (`[label](url)`).

## Menus

- **# blocks.** `#` at the start of a line or after a space opens the block
  menu: Heading, Bullet list, Numbered list, Quote, Code block, Divider.
  Typing filters it. `#` followed by a space still makes a heading, and `#`
  after a word character (`issue#12`) is text.
- **: emoji.** `:` plus two characters (`:sm`) shows the best matching emoji
  by their emoji-datasource short names. A complete `:smile:` converts by
  itself. The menu does not open inside code or after a word character, so
  `10:30` and URLs stay as typed.
- **@ mentions.** See [mentions](mentions.md).

Every menu works with the arrow keys, Enter or Tab to pick, Escape to close,
and the mouse.

Selecting text shows a toolbar: bold, italic, strike, inline code and link.
Link asks for an `http(s)` URL in the toolbar and writes `[text](url)`.

## Enter

- Enter sends.
- In a list, Enter makes a new item; Enter in an empty item leaves the list.
- In a code block, Enter makes a new line; Enter on an empty last line
  leaves the block.
- Shift+Enter is always a new line.
- On touch devices Return writes a new line or item and the send button
  sends.

## For developers

`packages/client/src/lib/composer-parts.ts` is the only converter between
the Tiptap document and a message: `serializeComposer` writes Markdown (via
`@tiptap/markdown`) into `parts-v1` with mentions as user references, and
`composerToDocument` parses Markdown or a draft back into blocks. The parser
reads only the syntax the composer can show; everything else stays literal
text. The menus live in `components/composer-extensions.ts`; block menu
entries are data (`components/block-menu-items.ts`), so later sections, such
as channels, can be appended. All `@tiptap/*` packages share one exact
version because they pin exact peer versions.
