# Message composer

The composer formats while you type. Messages are still stored and sent as
Markdown; the composer's document decides what that Markdown says, so the
sent message shows what the composer showed.

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

Undo (Ctrl+Z or Backspace right after the conversion) keeps the characters
as typed, and they are sent as typed.

## Menus

- **# blocks.** `#` at the start of a line or after a space opens the block
  menu: Heading, Bullet list, Numbered list, Quote, Code block, Divider.
  Typing filters it. `#` followed by a space still makes a heading, and `#`
  after a word character (`issue#12`) is text. When nothing matches
  (`#42`), no menu shows and Enter sends.
- **: emoji.** `:` plus two characters (`:sm`) shows the best matching emoji
  by their emoji-datasource short names. A complete `:smile:` converts by
  itself. The menu does not open inside code or after a word character, so
  `10:30` and URLs stay as typed.
- **@ mentions.** See [mentions](mentions.md).

Every menu works with the arrow keys, Enter or Tab to pick, Escape to close,
and the mouse. Turning a line with a mention into a code block keeps the
name as `@name` text (code holds no mentions).

Selecting text shows a toolbar: bold, italic, strike, inline code and link.
Link asks for an `http(s)` URL in the toolbar and writes `[text](url)`. It
works on text within one line; a selection with a mention cannot be linked.

## Enter

- Enter sends.
- In a list, Enter makes a new item; Enter in an empty item leaves the list.
- In a code block, Enter makes a new line; Enter on an empty last line
  leaves the block.
- Shift+Enter is always a new line.
- On touch devices Return writes a new line or item and the send button
  sends.

## What is sent

The composer's document is the authority; Markdown is its stored form.

- **Formatting** (lists, quotes, code blocks, headings, dividers, bold,
  italic, strike, inline code) is written as Markdown.
- **Literal text is literal.** A character that Markdown would read as
  syntax where it stands is sent backslash-escaped: `2*3`, `snake_case`
  stays as is but `_x_` becomes `\_x\_`, a line `- not a list` becomes
  `\- not a list`, a heading ending in `#` keeps it. Pasted plain text is
  literal text too: pasted `**bold**` shows and is sent as `**bold**`, not
  as bold. Restoring a draft decodes the escapes.
- **Kept source.** Links and images (`[label](url)`, what pasted links
  become), autolinks (`<https://…>`), bare URLs, `$$…$$` math and HTML tags
  are sent byte for byte, never escaped or re-encoded, so signed URLs keep
  working. The composer shows them as source; the sent message renders them
  (HTML tags render as text). Tables typed as Markdown also stay source.
- **Marks Markdown cannot express.** Markdown can open and close a mark only
  next to certain characters. Whitespace at the edge of a mark always moves
  out of it, and punctuation at the edge moves out when the delimiter could
  not close or open there: bold `hi!` in `say hi!there` is sent as
  `say **hi**!there`. Overlapping marks are written with `_` delimiters where
  `*` runs would merge (`**a*b***_c_`). Each line with marks is parsed back
  with the message renderer's parser and the draft parser before sending; a
  mark range that would not come back as written is left out, never sent as
  stray `*` or HTML. Text is never changed.
- **Mentions** keep their user ID, also inside bold or list items. In inline
  code a mention is sent as its `@name` text.
- Leading whitespace of four or more columns on a line is sent as three
  spaces: Markdown would make it a code block, and it is not shown either way.

## For developers

`packages/client/src/lib/composer-parts.ts` is the only converter between
the Tiptap document and a message. `serializeComposer` writes blocks with
`@tiptap/markdown` and each line's inline content itself (escapes, kept
source, mark normalization and the read-back check above), into `parts-v1`
with mentions as user references. `composerToDocument` parses Markdown or a
draft back with the same kept-source patterns and decodes escapes. The
contract is tested from editing operations in
`components/RichInput.markdown.test.tsx`: each case sends through the real
renderer and restores the draft, and a seeded random-edit test checks that
the text never changes and no formatting appears that the composer did not
show. The menus live in `components/composer-extensions.ts`; block menu
entries are data (`components/block-menu-items.ts`), so later sections, such
as channels, can be appended. All `@tiptap/*` packages share one exact
version because they pin exact peer versions.
