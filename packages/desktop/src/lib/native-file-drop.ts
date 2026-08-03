import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { SHARED_ATTACHMENT_MAX_COUNT } from "./shared-attachments";

const MEDIA_TYPE_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jpe: "image/jpeg",
  jfif: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
};

interface NativeFileDropHandlers {
  onDragStateChange: (dragging: boolean) => void;
  onFiles: (files: File[]) => void | Promise<void>;
  onError: (message: string) => void;
}

export function isTauriRuntime() {
  return (
    typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
  );
}

function droppedFileName(path: string) {
  return path.split(/[\\/]/).pop() || "attachment";
}

function mediaTypeForFileName(fileName: string) {
  const extension = fileName.split(".").pop()?.toLowerCase();
  return extension ? (MEDIA_TYPE_BY_EXTENSION[extension] ?? "") : "";
}

function nativeDropErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "Failed to read dropped file";
}

export async function fileFromNativeDrop(path: string): Promise<File> {
  const contents = await invoke<ArrayBuffer>("read_dropped_file", {
    filePath: path,
  });
  const fileName = droppedFileName(path);
  return new File([contents], fileName, {
    type: mediaTypeForFileName(fileName),
  });
}

export async function listenForNativeFileDrops({
  onDragStateChange,
  onFiles,
  onError,
}: NativeFileDropHandlers) {
  return getCurrentWebviewWindow().onDragDropEvent(async (event) => {
    if (event.payload.type === "enter" || event.payload.type === "over") {
      onDragStateChange(true);
      return;
    }
    if (event.payload.type === "leave") {
      onDragStateChange(false);
      return;
    }

    onDragStateChange(false);
    const paths = event.payload.paths.slice(0, SHARED_ATTACHMENT_MAX_COUNT);
    try {
      const files = await Promise.all(paths.map(fileFromNativeDrop));
      if (files.length > 0) await onFiles(files);
      if (paths.length < event.payload.paths.length) {
        onError(
          `A message can contain at most ${SHARED_ATTACHMENT_MAX_COUNT} files`,
        );
      }
    } catch (error) {
      onError(nativeDropErrorMessage(error));
    }
  });
}
