import { useEffect, useRef, useMemo, forwardRef, useImperativeHandle } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Mention from "@tiptap/extension-mention";
import Placeholder from "@tiptap/extension-placeholder";
import { Extension, type AnyExtension } from "@tiptap/react";
import { createMentionSuggestion } from "./mention-suggestion";
import type { MentionUser } from "./MentionList";

interface RichInputProps {
  onSubmit: (text: string) => void;
  /** Called when user presses Enter with empty text. Return true if handled (e.g., images-only send). */
  onEmptySubmitAttempt?: () => boolean;
  placeholder?: string;
  disabled?: boolean;
  mentions?: MentionUser[];
  onCanSubmitChange?: (canSubmit: boolean) => void;
  onTextChange?: (text: string) => void;
  /** Pre-editor key hook (e.g. for a command menu). Return true to consume the event. */
  onKeyIntercept?: (event: KeyboardEvent) => boolean;
}

/** Newlines are paragraph splits, so serialize blocks with single "\n". */
const TEXT_OPTIONS = { blockSeparator: "\n" } as const;

export interface RichInputHandle {
  submit: () => void;
  focus: () => void;
  setText: (text: string) => void;
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
    onKeyIntercept,
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

  const mentionsRef = useRef(mentions);
  mentionsRef.current = mentions;

  const submitIfNotEmpty = (text: string, clearContent: () => void) => {
    const trimmed = text.trim();
    if (!trimmed) {
      // Allow empty-text submission when parent signals it's OK (e.g., images attached)
      if (onEmptySubmitAttemptRef.current?.()) {
        clearContent();
        return true;
      }
      return false;
    }
    onSubmitRef.current(trimmed);
    clearContent();
    onCanSubmitChangeRef.current?.(false);
    return true;
  };

  const submitExtension = useMemo(
    () =>
      Extension.create({
        name: "submitOnEnter",
        addKeyboardShortcuts() {
          return {
            Enter: ({ editor }) => {
              submitIfNotEmpty(editor.getText(TEXT_OPTIONS), () => editor.commands.clearContent());
              return true;
            },
            // Split a new paragraph rather than inserting a hard break:
            // WebKitGTK renders the caret on the wrong line after trailing
            // <br> elements, while real block splits position it correctly.
            "Shift-Enter": ({ editor }) => {
              editor.commands.splitBlock();
              return true;
            },
          };
        },
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
        heading: false,
        codeBlock: false,
        blockquote: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        horizontalRule: false,
        bold: false,
        italic: false,
        strike: false,
        code: false,
      }),
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
    editorProps: {
      attributes: {
        class:
          "block max-h-[200px] w-full overflow-y-auto bg-transparent px-4 pt-3 pb-11 font-[inherit] text-[1rem] leading-relaxed text-text outline-none",
      },
      // Direct view props run before extension keymaps, so interceptors
      // (slash command menu navigation) win over Enter-to-submit.
      handleKeyDown: (_view, event) => onKeyInterceptRef.current?.(event) ?? false,
    },
    onCreate: ({ editor: currentEditor }) => {
      const text = currentEditor.getText(TEXT_OPTIONS);
      onCanSubmitChangeRef.current?.(text.trim().length > 0);
      onTextChangeRef.current?.(text);
    },
    onUpdate: ({ editor: currentEditor }) => {
      const text = currentEditor.getText(TEXT_OPTIONS);
      onCanSubmitChangeRef.current?.(text.trim().length > 0);
      onTextChangeRef.current?.(text);
    },
  });

  useImperativeHandle(
    ref,
    () => ({
      submit: () => {
        if (!editor) return;
        submitIfNotEmpty(editor.getText(TEXT_OPTIONS), () => editor.commands.clearContent());
      },
      focus: () => {
        editor?.commands.focus("end");
      },
      setText: (text: string) => {
        if (!editor) return;
        editor.commands.setContent({
          type: "doc",
          content: text.split("\n").map((line) => ({
            type: "paragraph",
            content: line ? [{ type: "text", text: line }] : [],
          })),
        });
        onCanSubmitChangeRef.current?.(text.trim().length > 0);
        onTextChangeRef.current?.(text);
        editor.commands.focus("end");
      },
    }),
    [editor],
  );

  useEffect(() => {
    if (editor) editor.setEditable(!disabled);
  }, [editor, disabled]);

  return <EditorContent editor={editor} />;
});
