import mitt from "mitt";
import type {
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
  "ws:typing": {
    conversationId: string;
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
  "ws:member_removed": {
    workspaceId: string;
    userId: string;
  };
  "ws:invite_received": {
    invite: WorkspaceInvite;
  };
};

export const wsEvents = mitt<WsEvents>();
