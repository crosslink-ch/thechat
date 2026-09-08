import catalog from "../../../../release-notes.json";
import { isWeb } from "../platform/environment";

export interface ReleaseNote {
  version: string;
  title: string;
  date: string;
  body: string;
}

export const releaseNotesCatalog: readonly ReleaseNote[] = catalog;

export function resolveShippedReleaseVersion(web: boolean, desktopVersion: string, entries: readonly { version: string }[]) {
  // Desktop must describe the installed binary, never the next available update.
  // A deployed web bundle contains the catalog it shipped; reload brings new notes.
  return web ? entries[0]?.version ?? "unknown" : desktopVersion;
}

export const shippedReleaseVersion = resolveShippedReleaseVersion(
  isWeb,
  typeof __DESKTOP_RELEASE_VERSION__ === "undefined" ? "unknown" : __DESKTOP_RELEASE_VERSION__,
  releaseNotesCatalog,
);
