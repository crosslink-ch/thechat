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
}

export interface RichInputHandle {
  submit: () => void;
  focus: () => void;
}

export const RichInput = forwardRef<RichInputHandle, RichInputProps>(function RichInput(
  {
    onSubmit,
    onEmptySubmitAttempt,
    placeholder = "Send a message...",
    disabled = false,
    mentions,
    onCanSubmitChange,
  }: RichInputProps,
  ref,
) {
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;

  const onEmptySubmitAttemptRef = useRef(onEmptySubmitAttempt);
  onEmptySubmitAttemptRef.current = onEmptySubmitAttempt;

  const onCanSubmitChangeRef = useRef(onCanSubmitChange);
  onCanSubmitChangeRef.current = onCanSubmitChange;

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
              submitIfNotEmpty(editor.getText(), () => editor.commands.clearContent());
              return true;
            },
            "Shift-Enter": ({ editor }) => {
              editor.commands.enter();
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
    },
    onCreate: ({ editor: currentEditor }) => {
      onCanSubmitChangeRef.current?.(currentEditor.getText().trim().length > 0);
    },
    onUpdate: ({ editor: currentEditor }) => {
      onCanSubmitChangeRef.current?.(currentEditor.getText().trim().length > 0);
    },
  });

  useImperativeHandle(
    ref,
    () => ({
      submit: () => {
        if (!editor) return;
        submitIfNotEmpty(editor.getText(), () => editor.commands.clearContent());
      },
      focus: () => {
        editor?.commands.focus("end");
      },
    }),
    [editor],
  );

  useEffect(() => {
    if (editor) editor.setEditable(!disabled);
  }, [editor, disabled]);

  return <EditorContent editor={editor} />;
});
