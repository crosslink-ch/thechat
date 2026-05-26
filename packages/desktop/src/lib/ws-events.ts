import mitt from "mitt";
import type {
  BotInvocationPublic,
  BotInvocationProgressEventPublic,
  BotSessionPublic,
  ChatMessage,
  WorkspaceMember,
  WorkspaceMemberRole,
  WorkspaceInvite,
} from "@thechat/shared";

export type WsEvents = {
  "ws:new_message": {
    message: ChatMessage;
    conversationType: "direct" | "group";
  };
  "ws:bot_invocation_updated": {
    conversationId: string;
    context: BotSessionPublic | null;
    invocation: BotInvocationPublic;
  };
  "ws:bot_invocation_progress": {
    conversationId: string;
    invocationId: string;
    event: BotInvocationProgressEventPublic;
  };
  "ws:typing": {
    conversationId: string;
    userId: string;
    userName: string;
    botSessionId?: string | null;
  };
  "ws:member_joined": {
    workspaceId: string;
    member: WorkspaceMember;
  };
  "ws:member_role_changed": {
    workspaceId: string;
    userId: string;
    newRole: WorkspaceMemberRole;
  };
  "ws:member_removed": {
    workspaceId: string;
    userId: string;
  };
  "ws:invite_received": {
    invite: WorkspaceInvite;
  };
};

export const wsEvents = mitt<WsEvents>();
