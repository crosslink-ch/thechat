import type { ComponentType } from "react";
import type { Conversation } from "@thechat/shared";

export type CredentialKey = "auth_access_token" | "auth_user" | "auth_refresh_token";
export type PreferenceKey = "ui_font_size" | "active_workspace_id";
export interface KeyValueStore<K extends string> {
  get(key: K, account?: string): Promise<string | null>;
  set(key: K, value: string, account?: string): Promise<void>;
  delete(key: K, account?: string): Promise<void>;
}
export interface NativeFileDropHandlers {
  onDragStateChange(dragging: boolean): void;
  onFiles(files: File[]): void | Promise<void>;
  onError(message: string): void;
}
export interface NativeAttachmentDownload {
  savedPath: string;
  transferredBytes: number;
  httpStatus: number;
}
/** Narrow capabilities, selected by each executable's bundler. No generic IPC. */
export interface PlatformServices {
  credentials: KeyValueStore<CredentialKey> | null;
  preferences: KeyValueStore<PreferenceKey>;
  announceSessionChange(): void;
  log(level: "info" | "error" | "warn" | "debug" | "trace", message: string): Promise<void>;
  notifications: {
    permitDelivery(): Promise<boolean>;
    send(title: string, body: string): void | Promise<void>;
  };
  localConversations: { list(): Promise<Conversation[]> } | null;
  nativeFiles: {
    available(): boolean;
    listen(handlers: NativeFileDropHandlers): Promise<() => void>;
    download(url: string, suggestedFileName?: string): Promise<NativeAttachmentDownload>;
  } | null;
}
export interface PlatformShell {
  usePlatformLifecycle(token: string | null): void;
  PlatformDialogs: ComponentType;
  PlatformTitlebar: ComponentType;
  PlatformUpdateToast: ComponentType;
  PlatformSidebarUpdate: ComponentType;
  PlatformNotificationSettings: ComponentType;
}
