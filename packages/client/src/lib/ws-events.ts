import mitt from "mitt";
import type {
  BotAppearance,
  BotInvocationPublic,
  BotInvocationProgressEventPublic,
  BotRequestPublic,
  BotWorkspaceInvite,
  BotWorkspaceInviteStatus,
  ChatMessage,
  ConversationThreadPublic,
  TaskProjectPublic,
  WorkspaceChannel,
  WorkspaceMember,
  WorkspaceMemberRole,
  WorkspaceInvite,
} from "@thechat/shared";

export type WsEvents = {
  "ws:authenticated": Record<string, never>;
  "ws:new_message": {
    message: ChatMessage;
    conversationType: "direct" | "group";
    clientMessageId?: string;
  };
  "ws:message_reactions_updated": {
    conversationId: string;
    messageId: string;
  };
  "ws:message_error": {
    conversationId: string;
    clientMessageId: string;
    message: string;
  };
  "ws:bot_invocation_updated": {
    conversationId: string;
    invocation: BotInvocationPublic;
  };
  "ws:bot_invocation_progress": {
    conversationId: string;
    invocationId: string;
    event: BotInvocationProgressEventPublic;
    invocation?: BotInvocationPublic;
  };
  "ws:bot_request_updated": {
    conversationId: string;
    request: BotRequestPublic;
  };
  "ws:conversation_thread_updated": {
    conversationId: string;
    thread: ConversationThreadPublic;
  };
  "ws:conversation_thread_deleted": {
    conversationId: string;
    threadId: string;
  };
  "ws:task_project_updated": {
    conversationId: string;
    project: TaskProjectPublic;
  };
  "ws:task_project_deleted": {
    conversationId: string;
    projectId: string;
  };
  "ws:typing": {
    conversationId: string;
    threadId: string | null;
    userId: string;
    userName: string;
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
  "ws:member_updated": {
    workspaceId: string;
    userId: string;
    name: string;
    botAvatar?: BotAppearance;
  };
  "ws:member_removed": {
    workspaceId: string;
    userId: string;
  };
  "ws:channel_created": {
    workspaceId: string;
    channel: WorkspaceChannel;
  };
  "ws:channel_renamed": {
    workspaceId: string;
    channel: WorkspaceChannel;
  };
  "ws:channel_deleted": {
    workspaceId: string;
    channelId: string;
  };
  "ws:invite_received": {
    invite: WorkspaceInvite;
  };
  "ws:bot_workspace_invite_received": {
    invite: BotWorkspaceInvite;
  };
  "ws:bot_workspace_invite_resolved": {
    inviteId: string;
    workspaceId: string;
    botId: string;
    status: Exclude<BotWorkspaceInviteStatus, "pending">;
  };
  "ws:presence_snapshot": {
    userIds: string[];
  };
  "ws:presence_changed": {
    userId: string;
    online: boolean;
  };
};

export const wsEvents = mitt<WsEvents>();
