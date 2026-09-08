import { create } from "zustand";

export interface ReleaseNotesPreview {
  version: string;
  body?: string;
}

type ReleaseNotesRequest = { kind: "history" } | { kind: "preview"; preview: ReleaseNotesPreview };

// Presentation only: previews/manual reads never acknowledge an installed release.
export const useReleaseNotesStore = create<{ request: ReleaseNotesRequest | null }>(() => ({ request: null }));

export function openReleaseNotes() {
  useReleaseNotesStore.setState({ request: { kind: "history" } });
}

export function previewReleaseNotes(preview: ReleaseNotesPreview) {
  useReleaseNotesStore.setState({ request: { kind: "preview", preview } });
}

export function closeReleaseNotes() {
  useReleaseNotesStore.setState({ request: null });
}
