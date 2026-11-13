import { useEffect, useRef, useMemo, forwardRef, useImperativeHandle } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Mention from "@tiptap/extension-mention";
import Placeholder from "@tiptap/extension-placeholder";
import type { AnyExtension } from "@tiptap/react";
import { Fragment, Slice, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import { projectPartsContent, trimInputParts } from "@thechat/shared";
import { createMentionSuggestion } from "./mention-suggestion";
import { BlockMenu, EmojiMenu, createEnterRules } from "./composer-extensions";
import { SelectionToolbar } from "./SelectionToolbar";
import type { MentionUser } from "./MentionList";
import {
  composerFromText,
  composerToDocument,
  sameComposerDocument,
  serializeComposer,
  serializeTextNode,
  type ComposerDocument,
  type MessageInput,
} from "../lib/composer-parts";

interface RichInputProps {
  /**
   * The message to send: ordered text and the user references picked in the
   * @ menu, with its readable text. Trimmed; never empty.
   */
  onSubmit: (message: ComposerDocument) => void | boolean | Promise<void | boolean>;
  /** Called when user presses Enter with empty text. Return true if handled (e.g., images-only send). */
  onEmptySubmitAttempt?: () => boolean | Promise<boolean>;
  placeholder?: string;
  disabled?: boolean;
  mentions?: MentionUser[];
  onCanSubmitChange?: (canSubmit: boolean) => void;
  onTextChange?: (text: string) => void;
  /** The whole draft, mentions included, after every change. */
  onChange?: (message: ComposerDocument) => void;
  /** Pre-editor key hook (e.g. for a command menu). Return true to consume the event. */
  onKeyIntercept?: (event: KeyboardEvent) => boolean;
  /** Draft used when this editor instance is created: text or a parts document. */
  initialValue?: MessageInput;
  /** Accessible name of the editor. */
  ariaLabel?: string;
}

/** The editor's message: parts, labels and readable text. */
function composerOf(doc: ProseMirrorNode): ComposerDocument {
  return serializeComposer(doc);
}

/** Parts trimmed like the server trims a message; empty when nothing to send. */
function trimmedComposer(document: ComposerDocument): ComposerDocument {
  const parts = trimInputParts(document.parts);
  return {
    parts,
    labels: document.labels,
    text: projectPartsContent(parts, (id) => document.labels[id]),
  };
}


/** Convert clipboard link marks before insertion, so display and send agree.
 * Preserve paragraphs, hard breaks and mention atoms; discard hidden text marks.
 * A slice keeps its openness so native paste still replaces/inserts at the caret.
 */
function markdownPaste(slice: Slice, view: EditorView): Slice {
  const { from } = view.state.selection;
  const precedingText = view.state.doc.textBetween(Math.max(0, from - 1), from);
  const normalize = (parent: ProseMirrorNode, atStart: boolean): ProseMirrorNode => {
    const children: ProseMirrorNode[] = [];
    parent.forEach((child, _offset, index) => {
      if (child.isText) {
        const text = serializeTextNode(
          child, parent, index, atStart && index === 0 ? precedingText : "",
        );
        if (text) children.push(parent.type.schema.text(text));
      } else {
        children.push(child.isLeaf ? child : normalize(child, atStart && index === 0));
      }
    });
    return parent.copy(Fragment.fromArray(children));
  };
  if (!slice.content.firstChild) return slice;
  // Inline clipboard slices can contain text directly, without a paragraph.
  const schema = slice.content.firstChild.type.schema;
  const parent = schema.topNodeType.create(null, slice.content);
  return new Slice(normalize(parent, true).content, slice.openStart, slice.openEnd);
}

export interface RichInputHandle {
  submit: () => void;
  focus: () => void;
  setText: (text: string) => void;
  /** Replace the draft with text or a parts document (mentions restored). */
  setValue: (value: MessageInput) => void;
}

export const RichInput = forwardRef<RichInputHandle, RichInputProps>(function RichInput(
  {
    onSubmit,
    onEmptySubmitAttempt,
    placeholder = "Send a message...",
    disabled = false,
    mentions,
    onCanSubmitChange,
    onTextChange,
    onChange,
    onKeyIntercept,
    initialValue = "",
    ariaLabel = "Message",
  }: RichInputProps,
  ref,
) {
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;

  const onEmptySubmitAttemptRef = useRef(onEmptySubmitAttempt);
  onEmptySubmitAttemptRef.current = onEmptySubmitAttempt;

  const onKeyInterceptRef = useRef(onKeyIntercept);
  onKeyInterceptRef.current = onKeyIntercept;

  const onCanSubmitChangeRef = useRef(onCanSubmitChange);
  onCanSubmitChangeRef.current = onCanSubmitChange;

  const onTextChangeRef = useRef(onTextChange);
  onTextChangeRef.current = onTextChange;

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const notifyChange = (message: ComposerDocument) => {
    onCanSubmitChangeRef.current?.(trimInputParts(message.parts).length > 0);
    onTextChangeRef.current?.(message.text);
    onChangeRef.current?.(message);
  };

  const mentionsRef = useRef(mentions);
  mentionsRef.current = mentions;
  /** A restored mention shows the target's current name when known. */
  const labelOf = (id: string) => mentionsRef.current?.find((mention) => mention.id === id)?.label;

  const submittingRef = useRef(false);

  const submitIfNotEmpty = (
    message: ComposerDocument,
    clearContent: () => boolean,
  ): boolean | Promise<boolean> => {
    if (submittingRef.current) return false;
    const trimmed = trimmedComposer(message);
    const hasContent = trimmed.parts.length > 0;
    const complete = (result: void | boolean) => {
      const accepted = hasContent ? result !== false : result === true;
      if (!accepted) return false;
      if (clearContent()) notifyChange(composerFromText(""));
      return true;
    };

    submittingRef.current = true;
    try {
      const result = hasContent
        ? onSubmitRef.current(trimmed)
        : onEmptySubmitAttemptRef.current?.();
      if (result && typeof (result as PromiseLike<void | boolean>).then === "function") {
        return Promise.resolve(result)
          .then(complete)
          .catch(() => false)
          .finally(() => {
            submittingRef.current = false;
          });
      }
      const accepted = complete(result as void | boolean);
      submittingRef.current = false;
      return accepted;
    } catch {
      // Submission ownership stays with the caller. A rejected transition must
      // leave the editor recoverable for retry.
      submittingRef.current = false;
      return false;
    }
  };

  const submitExtension = useMemo(
    () =>
      createEnterRules((editor) => {
        const submitted = composerOf(editor.state.doc);
        void submitIfNotEmpty(submitted, () => {
          // Do not erase edits made while an asynchronous submit was
          // waiting for persistence acknowledgement.
          if (sameComposerDocument(composerOf(editor.state.doc), submitted)) {
            editor.commands.clearContent();
            return true;
          }
          return false;
        });
      }),
    [],
  );

  const suggestion = useMemo(() => {
    if (!mentions) return undefined;
    return createMentionSuggestion(() => mentionsRef.current ?? []);
  }, [!!mentions]);

  const extensions = useMemo(() => {
    const exts: AnyExtension[] = [
      StarterKit.configure({
        underline: false,
        trailingNode: false,
        heading: { levels: [1, 2, 3] },
        // Enter rules for code blocks live in createEnterRules.
        codeBlock: { exitOnTripleEnter: false },
        // Keep the parser for clipboard anchors, not a rich/autolinking editor.
        link: { autolink: false, linkOnPaste: false, openOnClick: false },
      }),
      BlockMenu,
      EmojiMenu,
      Placeholder.configure({ placeholder }),
      submitExtension,
    ];

    if (suggestion) {
      exts.push(
        Mention.configure({
          HTMLAttributes: { class: "mention" },
          renderText: ({ node }) => `@${node.attrs.label}`,
          suggestion,
        }),
      );
    }

    return exts;
  }, [placeholder, submitExtension, suggestion]);

  const editor = useEditor({
    extensions,
    // Link's paste rule would otherwise mark URLs inside generated Markdown.
    enablePasteRules: false,
    content: composerToDocument(initialValue, labelOf, { mentions: Boolean(mentionsRef.current) }),
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-label": ariaLabel,
        "aria-multiline": "true",
        enterkeyhint: "enter",
        class:
          "composer-content md-content block max-h-[200px] w-full overflow-y-auto bg-transparent px-4 pb-1.5 pt-3 font-[inherit] text-[1rem] leading-relaxed text-text outline-none",
      },
      // Direct view props run before extension keymaps, so interceptors
      // (slash command menu navigation) win over Enter-to-submit.
      handleKeyDown: (_view, event) => onKeyInterceptRef.current?.(event) ?? false,
      transformPasted: markdownPaste,
    },
    onCreate: ({ editor: currentEditor }) => {
      notifyChange(composerOf(currentEditor.state.doc));
    },
    onUpdate: ({ editor: currentEditor }) => {
      notifyChange(composerOf(currentEditor.state.doc));
    },
  });

  useImperativeHandle(
    ref,
    () => ({
      submit: () => {
        if (!editor) return;
        const submitted = composerOf(editor.state.doc);
        void submitIfNotEmpty(submitted, () => {
          if (sameComposerDocument(composerOf(editor.state.doc), submitted)) {
            editor.commands.clearContent();
            return true;
          }
          return false;
        });
      },
      focus: () => {
        editor?.commands.focus("end");
      },
      setText: (text: string) => {
        if (!editor) return;
        editor.commands.setContent(composerToDocument(text));
        notifyChange(composerOf(editor.state.doc));
        editor.commands.focus("end");
      },
      setValue: (value: MessageInput) => {
        if (!editor) return;
        editor.commands.setContent(
          composerToDocument(value, labelOf, { mentions: Boolean(editor.schema.nodes.mention) }),
        );
        notifyChange(composerOf(editor.state.doc));
        editor.commands.focus("end");
      },
    }),
    [editor],
  );

  useEffect(() => {
    if (editor) editor.setEditable(!disabled);
  }, [editor, disabled]);

  return (
    <>
      <EditorContent editor={editor} />
      {editor && <SelectionToolbar editor={editor} />}
    </>
  );
});
