import { memo, useEffect, useRef, useState, useCallback, type DragEvent } from "react";
import { useIsStreaming } from "../stores/streaming";
import { useInputFocusStore } from "../stores/input-focus";
import { useComposerDraftsStore } from "../stores/composer-drafts";
import { RichInput, type RichInputHandle } from "./RichInput";
import { SlashCommandMenu } from "./SlashCommandMenu";
import type { MentionUser } from "./MentionList";
import type { ImageAttachment } from "../lib/images";
import {
  cancelSharedAttachment,
  SHARED_ATTACHMENT_MAX_BYTES,
  SHARED_ATTACHMENT_MAX_COUNT,
  uploadSharedAttachment,
  type SharedAttachmentDraft,
} from "../lib/shared-attachments";
import {
  filterHermesSlashCommands,
  slashCommandRequiresArgs,
  type HermesSlashCommand,
} from "../lib/hermes-slash-commands";
import {
  isTauriRuntime,
  listenForNativeFileDrops,
} from "../lib/native-file-drop";

const ACCEPTED_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "image/bmp"]);
const EMPTY_IMAGE_DRAFTS: ImageAttachment[] = [];
const EMPTY_SHARED_DRAFTS: SharedAttachmentDraft[] = [];
const sharedUploadControllers = new Map<string, AbortController>();

const sharedUploadControllerKey = (draftKey: string, localId: string) =>
  `${draftKey}\u0000${localId}`;

function fileToAttachment(file: File): Promise<ImageAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1];
      resolve({ id: crypto.randomUUID(), mimeType: file.type, base64 });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export type InputSendResult = void | boolean | string | null;

interface InputBarProps {
  convId: string | undefined;
  draftKey: string;
  onSend: (
    content: string,
    images?: ImageAttachment[],
    attachmentIds?: string[],
  ) => InputSendResult | Promise<InputSendResult>;
  onStop: () => void;
  mentions?: MentionUser[];
  autoFocusKey?: string;
  isStreamingOverride?: boolean;
  allowQueueWhileStreaming?: boolean;
  allowImages?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  queuedCount?: number;
  slashCommands?: HermesSlashCommand[];
  sharedUpload?: {
    conversationId: string;
    token: string;
  };
}

export const InputBar = memo(function InputBar(props: InputBarProps) {
  return <ScopedInputBar key={props.draftKey} {...props} />;
});

function ScopedInputBar({
  convId,
  draftKey,
  onSend,
  onStop,
  mentions,
  autoFocusKey,
  isStreamingOverride,
  allowQueueWhileStreaming = true,
  allowImages = true,
  disabled = false,
  disabledReason,
  queuedCount = 0,
  slashCommands,
  sharedUpload,
}: InputBarProps) {
  const storeStreaming = useIsStreaming(convId);
  const isStreaming = isStreamingOverride ?? storeStreaming;
  const composerDisabled =
    disabled || (isStreaming && !allowQueueWhileStreaming);
  const inputRef = useRef<RichInputHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [canSubmit, setCanSubmit] = useState(false);
  const storedImages = useComposerDraftsStore(
    (state) => state.imageDrafts[draftKey],
  );
  const images = storedImages ?? EMPTY_IMAGE_DRAFTS;
  const storedSharedDrafts = useComposerDraftsStore(
    (state) => state.attachmentDrafts[draftKey],
  );
  const sharedDrafts = storedSharedDrafts ?? EMPTY_SHARED_DRAFTS;
  const sendingShared = useComposerDraftsStore(
    (state) => state.sendingAttachments[draftKey] ?? false,
  );
  const [sharedError, setSharedError] = useState<string | null>(null);
  const sharedDraftsRef = useRef<SharedAttachmentDraft[]>(sharedDrafts);
  sharedDraftsRef.current = sharedDrafts;
  const inFlightAttachmentIdsRef = useRef(new Set<string>());
  const mountedRef = useRef(true);
  const sharedScopeRef = useRef(sharedUpload);
  const [dragOver, setDragOver] = useState(false);
  const [initialText] = useState(
    () => useComposerDraftsStore.getState().drafts[draftKey] ?? "",
  );
  const [inputText, setInputText] = useState(initialText);
  const localTextRef = useRef(initialText);
  const sendPendingRef = useRef(false);
  const storedText = useComposerDraftsStore(
    (state) => state.drafts[draftKey] ?? "",
  );
  const setDraft = useComposerDraftsStore((state) => state.setDraft);
  const restoreDraft = useComposerDraftsStore((state) => state.restoreDraft);
  const setImageDrafts = useComposerDraftsStore((state) => state.setImageDrafts);
  const setAttachmentDrafts = useComposerDraftsStore(
    (state) => state.setAttachmentDrafts,
  );
  const setSendingAttachments = useComposerDraftsStore(
    (state) => state.setSendingAttachments,
  );
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  const [slashMenuDismissed, setSlashMenuDismissed] = useState(false);

  const updateImages = useCallback(
    (
      update:
        | ImageAttachment[]
        | ((current: ImageAttachment[]) => ImageAttachment[]),
    ) => {
      const current =
        useComposerDraftsStore.getState().imageDrafts[draftKey] ??
        EMPTY_IMAGE_DRAFTS;
      const next = typeof update === "function" ? update(current) : update;
      setImageDrafts(draftKey, next);
    },
    [draftKey, setImageDrafts],
  );

  const updateInputText = useCallback(
    (text: string) => {
      localTextRef.current = text;
      setInputText(text);
      setDraft(draftKey, text);
    },
    [draftKey, setDraft],
  );

  useEffect(() => {
    // Ignore effects from a render that predates a synchronous local store
    // write. Otherwise a slash-menu insertion can be overwritten by the old
    // draft value before Zustand delivers the next subscribed render.
    const liveStoredText =
      useComposerDraftsStore.getState().drafts[draftKey] ?? "";
    if (storedText !== liveStoredText || storedText === localTextRef.current) {
      return;
    }
    localTextRef.current = storedText;
    setInputText(storedText);
    inputRef.current?.setText(storedText);
  }, [draftKey, storedText]);

  const sharedReady =
    sharedDrafts.length === 0 ||
    sharedDrafts.every((draft) => draft.phase === "ready");
  const hasContent =
    canSubmit || images.length > 0 || sharedDrafts.length > 0;
  const canSend =
    !disabled &&
    hasContent &&
    (!isStreaming || allowQueueWhileStreaming) &&
    (!sharedUpload || (sharedReady && !sendingShared));
  const slashSuggestions = slashCommands
    ? filterHermesSlashCommands(inputText, slashCommands)
    : [];
  const slashMenuOpen = slashSuggestions.length > 0 && !slashMenuDismissed;
  const highlightedSlashIndex = Math.min(
    slashSelectedIndex,
    Math.max(slashSuggestions.length - 1, 0),
  );

  useEffect(() => {
    if (!autoFocusKey) return;
    inputRef.current?.focus();
  }, [autoFocusKey]);

  // Re-focus when another UI surface (command palette, picker, etc.) requests it
  const focusTick = useInputFocusStore((s) => s.focusTick);
  useEffect(() => {
    if (focusTick > 0) {
      inputRef.current?.focus();
    }
  }, [focusTick]);

  const updateSharedDrafts = useCallback(
    (
      update:
        | SharedAttachmentDraft[]
        | ((current: SharedAttachmentDraft[]) => SharedAttachmentDraft[]),
    ) => {
      const current =
        useComposerDraftsStore.getState().attachmentDrafts[draftKey] ??
        EMPTY_SHARED_DRAFTS;
      const next =
        typeof update === "function"
          ? update(current)
          : update;
      sharedDraftsRef.current = next;
      setAttachmentDrafts(draftKey, next);
    },
    [draftKey, setAttachmentDrafts],
  );

  const updateSharedDraft = useCallback(
    (
      localId: string,
      patch: Partial<Omit<SharedAttachmentDraft, "localId" | "file">>,
    ) => {
      updateSharedDrafts((previous) =>
        previous.map((draft) =>
          draft.localId === localId ? { ...draft, ...patch } : draft,
        ),
      );
    },
    [updateSharedDrafts],
  );

  const startSharedUpload = useCallback(
    (draft: SharedAttachmentDraft) => {
      if (!sharedUpload) return;
      const controller = new AbortController();
      const controllerKey = sharedUploadControllerKey(draftKey, draft.localId);
      sharedUploadControllers.get(controllerKey)?.abort();
      sharedUploadControllers.set(controllerKey, controller);
      void uploadSharedAttachment(
        {
          conversationId: sharedUpload.conversationId,
          token: sharedUpload.token,
          file: draft.file,
          signal: controller.signal,
        },
        (update) => {
          const current = sharedDraftsRef.current.find(
            (candidate) => candidate.localId === draft.localId,
          );
          const previewUrl =
            current &&
            update.phase === "ready" &&
            update.attachment?.kind === "image" &&
            !current.previewUrl
              ? URL.createObjectURL(
                  draft.file.slice(
                    0,
                    draft.file.size,
                    update.attachment.mediaType,
                  ),
                )
              : null;
          updateSharedDraft(draft.localId, {
            phase: update.phase,
            progress: update.progress,
            ...(update.attachment
              ? { attachment: update.attachment }
              : {}),
            ...(previewUrl ? { previewUrl } : {}),
            error: null,
          });
        },
      )
        .catch((error) => {
          if (controller.signal.aborted) {
            if (
              mountedRef.current &&
              !(error instanceof DOMException && error.name === "AbortError")
            ) {
              setSharedError(
                error instanceof Error
                  ? error.message
                  : "Failed to clean up cancelled attachment",
              );
            }
            return;
          }
          updateSharedDraft(draft.localId, {
            phase: "error",
            error:
              error instanceof Error ? error.message : "Attachment upload failed",
          });
          if (mountedRef.current) {
            setSharedError(
              error instanceof Error ? error.message : "Attachment upload failed",
            );
          }
        })
        .finally(() => {
          if (sharedUploadControllers.get(controllerKey) === controller) {
            sharedUploadControllers.delete(controllerKey);
          }
        });
    },
    [draftKey, sharedUpload, updateSharedDraft],
  );

  const addFiles = useCallback(async (files: FileList | File[]) => {
    if (!allowImages && !sharedUpload) return;
    if (sharedUpload) {
      if (sendingShared) return;
      const remaining = Math.max(
        0,
        SHARED_ATTACHMENT_MAX_COUNT - sharedDrafts.length,
      );
      const candidates = Array.from(files).slice(0, remaining);
      const rejected = candidates.find(
        (file) =>
          file.size < 1 ||
          file.size > SHARED_ATTACHMENT_MAX_BYTES,
      );
      if (remaining === 0 || candidates.length < Array.from(files).length) {
        setSharedError(
          `A message can contain at most ${SHARED_ATTACHMENT_MAX_COUNT} files`,
        );
      } else if (rejected) {
        setSharedError(
          `File must be non-empty and no larger than ${Math.round(
            SHARED_ATTACHMENT_MAX_BYTES / 1024 / 1024,
          )} MiB: ${rejected.name}`,
        );
      } else {
        setSharedError(null);
      }
      const accepted = candidates.filter(
        (file) =>
          file.size > 0 &&
          file.size <= SHARED_ATTACHMENT_MAX_BYTES,
      );
      const drafts = accepted.map<SharedAttachmentDraft>((file) => ({
        localId: crypto.randomUUID(),
        file,
        previewUrl: null,
        phase: "queued",
        progress: 0,
        attachment: null,
        error: null,
      }));
      updateSharedDrafts((previous) => [...previous, ...drafts]);
      for (const draft of drafts) startSharedUpload(draft);
      return;
    }
    const validFiles = Array.from(files).filter((f) => ACCEPTED_MIME.has(f.type));
    if (validFiles.length === 0) return;
    const attachments = await Promise.all(validFiles.map(fileToAttachment));
    updateImages((previous) => [...previous, ...attachments]);
  }, [
    allowImages,
    sendingShared,
    sharedDrafts.length,
    sharedUpload,
    startSharedUpload,
    updateImages,
    updateSharedDrafts,
  ]);

  const addFilesRef = useRef(addFiles);
  useEffect(() => {
    addFilesRef.current = addFiles;
  }, [addFiles]);

  useEffect(() => {
    if (!isTauriRuntime()) return;

    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenForNativeFileDrops({
      onDragStateChange: (dragging) => {
        if (!disposed) setDragOver(dragging);
      },
      onFiles: (files) => {
        if (!disposed) return addFilesRef.current(files);
      },
      onError: (message) => {
        if (!disposed) setSharedError(message);
      },
    })
      .then((stopListening) => {
        if (disposed) stopListening();
        else unlisten = stopListening;
      })
      .catch((error) => {
        if (!disposed) {
          setSharedError(
            error instanceof Error
              ? error.message
              : "Failed to listen for dropped files",
          );
        }
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const removeImage = useCallback((id: string) => {
    updateImages((previous) => previous.filter((image) => image.id !== id));
  }, [updateImages]);

  const removeSharedDraft = useCallback(
    async (draft: SharedAttachmentDraft) => {
      if (sendingShared) return;
      const controllerKey = sharedUploadControllerKey(draftKey, draft.localId);
      sharedUploadControllers.get(controllerKey)?.abort();
      sharedUploadControllers.delete(controllerKey);
      if (draft.attachment && sharedUpload) {
        updateSharedDraft(draft.localId, {
          phase: "cancelling",
          error: null,
        });
        try {
          await cancelSharedAttachment(
            draft.attachment.id,
            sharedUpload.token,
          );
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "Failed to cancel attachment";
          updateSharedDraft(draft.localId, {
            phase: "error",
            error: message,
          });
          setSharedError(message);
          return;
        }
      }
      if (draft.previewUrl) URL.revokeObjectURL(draft.previewUrl);
      updateSharedDrafts((previous) =>
        previous.filter((candidate) => candidate.localId !== draft.localId),
      );
    },
    [
      draftKey,
      sendingShared,
      sharedUpload,
      updateSharedDraft,
      updateSharedDrafts,
    ],
  );

  const retrySharedDraft = useCallback(
    async (draft: SharedAttachmentDraft) => {
      if (sendingShared) return;
      const controllerKey = sharedUploadControllerKey(draftKey, draft.localId);
      sharedUploadControllers.get(controllerKey)?.abort();
      sharedUploadControllers.delete(controllerKey);
      if (draft.attachment && sharedUpload) {
        updateSharedDraft(draft.localId, {
          phase: "cancelling",
          error: null,
        });
        try {
          await cancelSharedAttachment(
            draft.attachment.id,
            sharedUpload.token,
          );
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "Failed to cancel attachment before retry";
          updateSharedDraft(draft.localId, { phase: "error", error: message });
          setSharedError(message);
          return;
        }
      }
      const reset = {
        ...draft,
        phase: "queued" as const,
        progress: 0,
        attachment: null,
        error: null,
      };
      updateSharedDrafts((previous) =>
        previous.map((candidate) =>
          candidate.localId === draft.localId ? reset : candidate,
        ),
      );
      startSharedUpload(reset);
    },
    [
      draftKey,
      sendingShared,
      sharedUpload,
      startSharedUpload,
      updateSharedDraft,
      updateSharedDrafts,
    ],
  );

  useEffect(() => {
    const previous = sharedScopeRef.current;
    sharedScopeRef.current = sharedUpload;
    if (
      !previous ||
      !sharedUpload ||
      previous.conversationId === sharedUpload.conversationId
    ) {
      return;
    }
    for (const draft of sharedDraftsRef.current) {
      const controllerKey = sharedUploadControllerKey(draftKey, draft.localId);
      const controller = sharedUploadControllers.get(controllerKey);
      controller?.abort();
      sharedUploadControllers.delete(controllerKey);
      if (draft.previewUrl) URL.revokeObjectURL(draft.previewUrl);
      if (
        !controller &&
        draft.attachment &&
        !inFlightAttachmentIdsRef.current.has(draft.attachment.id)
      ) {
        void cancelSharedAttachment(
          draft.attachment.id,
          previous.token,
        ).catch(() => undefined);
      }
    }
    updateSharedDrafts([]);
    setSharedError(null);
  }, [draftKey, sharedUpload, updateSharedDrafts]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleSubmit = useCallback(() => {
    inputRef.current?.submit();
  }, []);

  const requestSend = useCallback(
    async (
      content: string,
      submittedImages?: ImageAttachment[],
      attachmentIds?: string[],
    ) => {
      if (sendPendingRef.current) return false;
      sendPendingRef.current = true;
      try {
        const result =
          attachmentIds !== undefined
            ? await onSend(content, submittedImages, attachmentIds)
            : submittedImages !== undefined
              ? await onSend(content, submittedImages)
              : await onSend(content);
        return result !== false;
      } finally {
        sendPendingRef.current = false;
      }
    },
    [onSend],
  );

  const sendSharedContent = useCallback(
    async (text: string) => {
      if (!sharedUpload) return false;
      const state = useComposerDraftsStore.getState();
      if (state.sendingAttachments[draftKey]) return false;
      const draftsToSend =
        state.attachmentDrafts[draftKey] ?? EMPTY_SHARED_DRAFTS;
      if (draftsToSend.some((draft) => draft.phase !== "ready")) return false;
      const attachmentIds = draftsToSend.map(
        (draft) => draft.attachment!.id,
      );
      const localIds = new Set(draftsToSend.map((draft) => draft.localId));
      for (const id of attachmentIds) {
        inFlightAttachmentIdsRef.current.add(id);
      }
      setSendingAttachments(draftKey, true);
      setSharedError(null);
      try {
        const accepted = await requestSend(text, undefined, attachmentIds);
        if (!accepted) return false;
        updateSharedDrafts((current) =>
          current.filter((draft) => !localIds.has(draft.localId)),
        );
        for (const draft of draftsToSend) {
          if (draft.previewUrl) URL.revokeObjectURL(draft.previewUrl);
        }
        return true;
      } catch (error) {
        if (mountedRef.current) {
          setSharedError(
            error instanceof Error ? error.message : "Failed to send message",
          );
        }
        return false;
      } finally {
        for (const id of attachmentIds) {
          inFlightAttachmentIdsRef.current.delete(id);
        }
        setSendingAttachments(draftKey, false);
      }
    },
    [
      draftKey,
      requestSend,
      setSendingAttachments,
      sharedUpload,
      updateSharedDrafts,
    ],
  );

  const removeAcceptedImages = useCallback(
    (acceptedImages: ImageAttachment[]) => {
      const acceptedIds = new Set(acceptedImages.map((image) => image.id));
      updateImages((current) =>
        current.filter((image) => !acceptedIds.has(image.id)),
      );
    },
    [updateImages],
  );

  const clearSubmittedText = useCallback(
    (submittedRevision: number) => {
      // This compare-and-set also clears a successfully sent draft after the
      // composer unmounts, without erasing edits made while the send was pending.
      restoreDraft(draftKey, submittedRevision, "");
    },
    [draftKey, restoreDraft],
  );

  const handleRichInputSubmit = useCallback(
    async (text: string) => {
      if (composerDisabled) return false;
      const submittedRevision =
        useComposerDraftsStore.getState().revisions[draftKey] ?? 0;
      const submittedImages = images.length > 0 ? [...images] : undefined;
      try {
        const accepted = sharedUpload
          ? await sendSharedContent(text)
          : await requestSend(text, submittedImages);
        if (!accepted) return false;
        const textIsStillSubmittedRevision =
          (useComposerDraftsStore.getState().revisions[draftKey] ?? 0) ===
          submittedRevision;
        clearSubmittedText(submittedRevision);
        if (textIsStillSubmittedRevision) {
          inputRef.current?.setText("");
          localTextRef.current = "";
          setInputText("");
        }
        if (submittedImages) removeAcceptedImages(submittedImages);
        return true;
      } catch {
        return false;
      }
    },
    [
      clearSubmittedText,
      composerDisabled,
      draftKey,
      images,
      removeAcceptedImages,
      requestSend,
      sendSharedContent,
      sharedUpload,
    ],
  );

  // Called when RichInput has empty text but user presses Enter — allow if images exist
  const handleEmptySubmitAttempt = useCallback(async () => {
    if (composerDisabled) return false;
    if (sharedUpload && sharedDrafts.length > 0 && sharedReady) {
      return sendSharedContent("");
    }
    if (images.length > 0) {
      const submittedImages = [...images];
      try {
        const accepted = await requestSend("", submittedImages);
        if (accepted) removeAcceptedImages(submittedImages);
        return accepted;
      } catch {
        return false;
      }
    }
    return false;
  }, [
    composerDisabled,
    images,
    removeAcceptedImages,
    requestSend,
    sendSharedContent,
    sharedDrafts.length,
    sharedReady,
    sharedUpload,
  ]);

  const handleInputTextChange = useCallback((text: string) => {
    updateInputText(text);
    // Typing re-opens an Esc-dismissed menu and resets the highlight.
    setSlashMenuDismissed(false);
    setSlashSelectedIndex(0);
  }, [updateInputText]);

  // Telegram-style selection: commands that need arguments are inserted for
  // further typing, argument-less commands are sent immediately.
  const handleSlashCommandSelect = useCallback(
    (command: HermesSlashCommand) => {
      if (slashCommandRequiresArgs(command)) {
        const text = `${command.command} `;
        inputRef.current?.setText(text);
        updateInputText(text);
        return;
      }
      // Route command sends through the same acknowledgement-aware RichInput
      // path so a rejected send keeps the exact command available for retry.
      inputRef.current?.setText(command.command);
      updateInputText(command.command);
      inputRef.current?.submit();
    },
    [updateInputText],
  );

  // RichInput reads this through a ref, so the latest render's state is used.
  const handleSlashMenuKey = useCallback(
    (event: KeyboardEvent) => {
      if (!slashMenuOpen) {
        if (
          event.key === "/" &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          inputText.length === 0 &&
          slashCommands &&
          slashCommands.length > 0
        ) {
          updateInputText("/");
          setSlashMenuDismissed(false);
          setSlashSelectedIndex(0);
        }
        return false;
      }
      switch (event.key) {
        case "ArrowDown":
          setSlashSelectedIndex((highlightedSlashIndex + 1) % slashSuggestions.length);
          return true;
        case "ArrowUp":
          setSlashSelectedIndex(
            (highlightedSlashIndex - 1 + slashSuggestions.length) % slashSuggestions.length,
          );
          return true;
        case "Enter": {
          if (event.shiftKey) return false;
          handleSlashCommandSelect(slashSuggestions[highlightedSlashIndex]);
          return true;
        }
        case "Tab": {
          const text = `${slashSuggestions[highlightedSlashIndex].command} `;
          inputRef.current?.setText(text);
          updateInputText(text);
          return true;
        }
        case "Escape":
          setSlashMenuDismissed(true);
          return true;
        default:
          return false;
      }
    },
    [
      handleSlashCommandSelect,
      highlightedSlashIndex,
      inputText,
      slashCommands,
      slashMenuOpen,
      slashSuggestions,
      updateInputText,
    ],
  );

  // Allow submit with only images (no text)
  const handleSendClick = useCallback(() => {
    if (sharedUpload) {
      if (!sharedReady || sendingShared) return;
      if (canSubmit || localTextRef.current.trim().length > 0) {
        handleSubmit();
      } else if (sharedDrafts.length > 0) {
        void sendSharedContent("");
      }
      return;
    }
    if (canSubmit || localTextRef.current.trim().length > 0) {
      handleSubmit();
    } else if (images.length > 0) {
      void handleEmptySubmitAttempt();
    }
  }, [
    canSubmit,
    handleEmptySubmitAttempt,
    handleSubmit,
    images.length,
    sendSharedContent,
    sendingShared,
    sharedDrafts.length,
    sharedReady,
    sharedUpload,
  ]);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (allowImages || sharedUpload) setDragOver(true);
  }, [allowImages, sharedUpload]);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      if (!allowImages && !sharedUpload) return;
      if (e.dataTransfer.files.length > 0) {
        addFiles(e.dataTransfer.files);
      }
    },
    [addFiles, allowImages, sharedUpload],
  );

  const handlePaste = useCallback(
    (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const imageFiles: File[] = [];
      for (const item of items) {
        if (
          item.kind === "file" &&
          (sharedUpload || (allowImages && ACCEPTED_MIME.has(item.type)))
        ) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        addFiles(imageFiles);
      }
    },
    [addFiles, allowImages, sharedUpload],
  );

  // Attach paste listener to the container
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener("paste", handlePaste as EventListener);
    return () => el.removeEventListener("paste", handlePaste as EventListener);
  }, [handlePaste]);

  return (
    <div className="px-4 pb-4 pt-2">
      <div
        ref={containerRef}
        className={`relative rounded-xl border bg-raised shadow-input transition-colors duration-150 focus-within:border-border-strong ${dragOver ? "border-accent border-dashed bg-accent/5" : "border-border"}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        // Telegram-style: the command menu hides while focus is elsewhere
        // and reappears when the input regains focus.
        onBlur={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setSlashMenuDismissed(true);
        }}
        onFocus={() => setSlashMenuDismissed(false)}
      >
        {/* Image preview strip */}
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {images.map((img) => (
              <div key={img.id} className="group relative">
                <img
                  src={`data:${img.mimeType};base64,${img.base64}`}
                  alt=""
                  className="size-16 rounded-lg border border-border object-cover"
                />
                <button
                  type="button"
                  className="absolute -top-1.5 -right-1.5 flex size-5 cursor-pointer items-center justify-center rounded-full border border-border bg-elevated text-[0.714rem] text-text-muted opacity-0 shadow-sm transition-opacity duration-100 group-hover:opacity-100 hover:bg-hover hover:text-text"
                  onClick={() => removeImage(img.id)}
                  title="Remove image"
                >
                  <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <path d="M1 1l6 6M7 1l-6 6" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
        {sharedDrafts.length > 0 && (
          <div
            className="flex flex-wrap gap-2 px-3 pt-3"
            aria-label="Attachment drafts"
          >
            {sharedDrafts.map((draft) => (
              <div
                key={draft.localId}
                data-testid="attachment-draft"
                data-attachment-file-name={draft.file.name}
                data-attachment-phase={draft.phase}
                data-attachment-progress={draft.progress}
                data-attachment-id={draft.attachment?.id ?? ""}
                className="relative flex min-w-44 max-w-64 items-center gap-2 rounded-lg border border-border bg-background p-2 pr-8"
              >
                {draft.previewUrl ? (
                  <img
                    src={draft.previewUrl}
                    alt=""
                    className="size-12 shrink-0 rounded object-cover"
                  />
                ) : (
                  <div className="flex size-12 shrink-0 items-center justify-center rounded bg-elevated text-lg" aria-hidden="true">
                    📎
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-text">
                    {draft.file.name}
                  </div>
                  <div className="text-[0.643rem] text-text-dimmed">
                    {formatFileSize(draft.file.size)} ·{" "}
                    {draft.phase === "error"
                      ? draft.error
                      : attachmentPhaseLabel(draft.phase)}
                  </div>
                  {draft.phase === "uploading" && (
                    <progress
                      value={draft.progress}
                      max={100}
                      aria-label={`Uploading ${draft.file.name}`}
                      className="mt-1 h-1 w-full accent-accent"
                    />
                  )}
                  {draft.phase === "error" && (
                    <button
                      type="button"
                      className="mt-1 text-[0.714rem] text-accent hover:underline"
                      onClick={() => void retrySharedDraft(draft)}
                      disabled={sendingShared}
                    >
                      Retry
                    </button>
                  )}
                </div>
                <button
                  type="button"
                  className="absolute right-1.5 top-1.5 flex size-5 cursor-pointer items-center justify-center rounded-full border border-border bg-elevated text-[0.714rem] text-text-muted shadow-sm hover:bg-hover hover:text-text"
                  onClick={() => void removeSharedDraft(draft)}
                  disabled={draft.phase === "cancelling" || sendingShared}
                  title={`Remove ${draft.file.name}`}
                  aria-label={`Remove ${draft.file.name}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {sharedError && (
          <div role="alert" className="px-3 pt-2 text-xs text-error-bright">
            {sharedError}
          </div>
        )}
        {slashMenuOpen && (
          <SlashCommandMenu
            commands={slashSuggestions}
            selectedIndex={highlightedSlashIndex}
            onSelect={handleSlashCommandSelect}
            onHighlight={setSlashSelectedIndex}
          />
        )}
        <RichInput
          ref={inputRef}
          initialText={initialText}
          onSubmit={handleRichInputSubmit}
          onEmptySubmitAttempt={handleEmptySubmitAttempt}
          placeholder={
            disabledReason ??
            (isStreaming
              ? allowQueueWhileStreaming
                ? "Queue a message..."
                : "Agent is working..."
              : "Send a message...")
          }
          disabled={composerDisabled}
          mentions={mentions}
          onCanSubmitChange={setCanSubmit}
          onTextChange={handleInputTextChange}
          onKeyIntercept={handleSlashMenuKey}
        />
        {allowImages && (
          <input
            ref={fileInputRef}
            type="file"
            accept={
              sharedUpload
                ? undefined
                : "image/png,image/jpeg,image/gif,image/webp,image/svg+xml,image/bmp"
            }
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
        )}
        {disabledReason && (
          <p className="px-4 pb-1 text-[0.714rem] text-text-dimmed">
            {disabledReason}
          </p>
        )}
        <div
          data-testid="input-actions"
          className="flex min-h-10 items-center justify-end gap-1.5 px-2 pb-2"
        >
          {allowQueueWhileStreaming && queuedCount > 0 && (
            <span className="mr-1 rounded border border-border bg-background px-1.5 py-0.5 text-[0.643rem] font-medium uppercase text-text-dimmed">
              {queuedCount} queued
            </span>
          )}
          {allowImages && (
            <button
              type="button"
              className="flex size-8 cursor-pointer items-center justify-center rounded-lg border-none bg-transparent text-text-dimmed shadow-none transition-colors duration-150 hover:bg-hover hover:text-text-muted disabled:cursor-default disabled:opacity-25"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled || Boolean(sharedUpload && sendingShared)}
              title={sharedUpload ? "Attach files" : "Attach image"}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="2" width="12" height="12" rx="2" />
                <circle cx="5.5" cy="5.5" r="1" />
                <path d="M14 10.5l-3.5-3.5L4 14" />
              </svg>
            </button>
          )}
          {isStreaming && allowQueueWhileStreaming && canSend && (
            <button
              className="flex size-8 cursor-pointer items-center justify-center rounded-lg border-none shadow-none transition-all duration-150 bg-accent/15 text-accent hover:bg-accent/25"
              onClick={handleSendClick}
              title="Queue message"
            >
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7.5 12V3.5" />
                <path d="M3.5 7L7.5 3L11.5 7" />
              </svg>
            </button>
          )}
          {isStreaming ? (
            <button
              className="flex size-8 cursor-pointer items-center justify-center rounded-lg border-none bg-error/15 text-error-bright shadow-none transition-colors duration-150 hover:bg-error/25"
              onClick={onStop}
              title="Stop generating"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                <rect x="2" y="2" width="10" height="10" rx="1.5" />
              </svg>
            </button>
          ) : (
            <button
              className="flex size-8 cursor-pointer items-center justify-center rounded-lg border-none shadow-none transition-all duration-150 disabled:cursor-default disabled:opacity-25 bg-accent/15 text-accent hover:not-disabled:bg-accent/25"
              disabled={!canSend}
              onClick={handleSendClick}
              title="Send message"
            >
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7.5 12V3.5" />
                <path d="M3.5 7L7.5 3L11.5 7" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function attachmentPhaseLabel(
  phase: SharedAttachmentDraft["phase"],
) {
  switch (phase) {
    case "queued":
      return "Queued";
    case "hashing":
      return "Preparing";
    case "uploading":
      return "Uploading";
    case "processing":
      return "Validating";
    case "cancelling":
      return "Removing";
    case "ready":
      return "Ready";
    case "error":
      return "Failed";
  }
}
