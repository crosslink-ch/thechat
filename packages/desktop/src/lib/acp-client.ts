/**
 * Single frontend boundary for the provisional ACP/Tauri contract.
 *
 * Keep command names, Channel argument names, and camelCase payloads here so
 * reconciliation with the Rust tranche is a one-file change.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  AcpConnectResult,
  AcpEvent,
  AcpPermissionMode,
  AcpPromptContent,
  AcpPromptResult,
  DbMessage,
} from "@thechat/shared";

export const ACP_COMMANDS = {
  beginTurn: "acp_begin_turn",
  completeTurn: "acp_complete_turn",
  connect: "acp_connect",
  prompt: "acp_prompt",
  cancel: "acp_cancel",
  respondPermission: "acp_respond_permission",
  disconnect: "acp_disconnect",
} as const;

export interface AcpConnectInput {
  conversationId: string;
  profileId: string;
  cwd: string;
  generation: number;
}

export interface AcpPromptInput {
  conversationId: string;
  turnToken: string;
  contentBlocks: AcpPromptContent[];
  permissionMode: AcpPermissionMode;
  generation: number;
}

export type AcpPersistedMessage = DbMessage;

export interface AcpBeginTurnInput extends AcpConversationGenerationInput {
  content: string;
  reasoningContent?: string | null;
}

export interface AcpBeginTurnResult {
  message: AcpPersistedMessage;
  turnToken: string;
}

export interface AcpCompleteTurnInput extends AcpConversationGenerationInput {
  turnToken: string;
  content: string;
  reasoningContent?: string | null;
}

export interface AcpConversationGenerationInput {
  conversationId: string;
  generation: number;
}

export interface AcpPermissionResponseInput
  extends AcpConversationGenerationInput {
  requestId: string;
  /** Exact opaque option ID from the adapter; null means cancel the request. */
  optionId: string | null;
}

type AcpEventHandler = (event: AcpEvent) => void;
type ChannelPurpose = "connect" | "prompt";

const CONNECT_LIFECYCLE_EVENTS = new Set<AcpEvent["type"]>([
  "connected",
  "error",
  "disconnected",
]);

export function beginAcpTurn(input: AcpBeginTurnInput): Promise<AcpBeginTurnResult> {
  return invoke<AcpBeginTurnResult>(ACP_COMMANDS.beginTurn, {
    conversationId: input.conversationId,
    generation: input.generation,
    content: input.content,
    reasoningContent: input.reasoningContent ?? null,
  });
}

export function completeAcpTurn(
  input: AcpCompleteTurnInput,
): Promise<AcpPersistedMessage> {
  return invoke<AcpPersistedMessage>(ACP_COMMANDS.completeTurn, {
    conversationId: input.conversationId,
    generation: input.generation,
    turnToken: input.turnToken,
    content: input.content,
    reasoningContent: input.reasoningContent ?? null,
  });
}

export function connectAcp(
  input: AcpConnectInput,
  onLifecycleEvent: AcpEventHandler,
): Promise<AcpConnectResult> {
  const onEvent = createScopedChannel(input, "connect", onLifecycleEvent);
  return invoke<AcpConnectResult>(ACP_COMMANDS.connect, {
    conversationId: input.conversationId,
    profileId: input.profileId,
    cwd: input.cwd,
    generation: input.generation,
    onEvent,
  });
}

export function promptAcp(
  input: AcpPromptInput,
  onEvent: AcpEventHandler,
): Promise<AcpPromptResult> {
  const eventChannel = createScopedChannel(input, "prompt", onEvent);
  return invoke<AcpPromptResult>(ACP_COMMANDS.prompt, {
    conversationId: input.conversationId,
    turnToken: input.turnToken,
    contentBlocks: input.contentBlocks,
    permissionMode: input.permissionMode,
    generation: input.generation,
    onEvent: eventChannel,
  });
}

export async function cancelAcp(
  input: AcpConversationGenerationInput,
): Promise<void> {
  await invoke<void>(ACP_COMMANDS.cancel, {
    conversationId: input.conversationId,
    generation: input.generation,
  });
}

export async function respondToAcpPermission(
  input: AcpPermissionResponseInput,
): Promise<void> {
  await invoke<void>(ACP_COMMANDS.respondPermission, {
    conversationId: input.conversationId,
    generation: input.generation,
    requestId: input.requestId,
    optionId: input.optionId,
  });
}

export async function disconnectAcp(
  input: AcpConversationGenerationInput,
): Promise<void> {
  await invoke<void>(ACP_COMMANDS.disconnect, {
    conversationId: input.conversationId,
    generation: input.generation,
  });
}

function createScopedChannel(
  scope: AcpConversationGenerationInput,
  purpose: ChannelPurpose,
  handler: AcpEventHandler,
): Channel<AcpEvent> {
  const channel = new Channel<AcpEvent>();
  channel.onmessage = (event) => {
    if (
      event.conversationId !== scope.conversationId ||
      event.generation !== scope.generation
    ) {
      return;
    }

    // Stable-v1 session/load may replay the complete transcript on connect.
    // SQLite is TheChat's visible history source, so replayed text/thought/tool
    // updates must never enter the current assistant stream or persistence path.
    if (purpose === "connect" && !CONNECT_LIFECYCLE_EVENTS.has(event.type)) {
      return;
    }

    handler(event);
  };
  return channel;
}
