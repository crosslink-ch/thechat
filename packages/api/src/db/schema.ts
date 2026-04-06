import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
  primaryKey,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import type { MessagePart } from "@thechat/shared";

// -- Enums --

export const userTypeEnum = pgEnum("user_type", ["human", "bot"]);
export const conversationTypeEnum = pgEnum("conversation_type", [
  "direct",
  "group",
]);
export const participantRoleEnum = pgEnum("participant_role", [
  "member",
  "admin",
  "owner",
]);
export const workspaceMemberRoleEnum = pgEnum("workspace_member_role", [
  "member",
  "admin",
  "owner",
]);
export const inviteStatusEnum = pgEnum("invite_status", [
  "pending",
  "accepted",
  "declined",
]);

// -- Tables --

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    email: varchar("email", { length: 255 }),
    type: userTypeEnum("type").notNull(),
    avatar: text("avatar"),
    passwordHash: text("password_hash"),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("users_email_idx").on(t.email),
    index("users_type_idx").on(t.type),
  ]
);

export const workspaces = pgTable("workspaces", {
  id: varchar("id", { length: 100 }).primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  createdById: uuid("created_by_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: varchar("workspace_id", { length: 100 })
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: workspaceMemberRoleEnum("role").notNull().default("member"),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    index("wm_workspace_id_idx").on(t.workspaceId),
    index("wm_user_id_idx").on(t.userId),
  ]
);

export const workspaceInvites = pgTable(
  "workspace_invites",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: varchar("workspace_id", { length: 100 })
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    inviterId: uuid("inviter_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    inviteeId: uuid("invitee_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: inviteStatusEnum("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("wi_workspace_id_idx").on(t.workspaceId),
    index("wi_invitee_id_idx").on(t.inviteeId),
    index("wi_inviter_id_idx").on(t.inviterId),
    uniqueIndex("wi_workspace_invitee_status_idx").on(
      t.workspaceId,
      t.inviteeId,
      t.status
    ),
  ]
);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    title: varchar("title", { length: 255 }),
    type: conversationTypeEnum("type").notNull(),
    workspaceId: varchar("workspace_id", { length: 100 }).references(
      () => workspaces.id,
      { onDelete: "cascade" }
    ),
    name: varchar("name", { length: 100 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("conversations_workspace_id_idx").on(t.workspaceId),
    uniqueIndex("conversations_workspace_name_idx").on(t.workspaceId, t.name),
  ]
);

export const conversationParticipants = pgTable(
  "conversation_participants",
  {
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: participantRoleEnum("role").notNull().default("member"),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.userId] }),
    index("cp_conversation_id_idx").on(t.conversationId),
    index("cp_user_id_idx").on(t.userId),
  ]
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    senderId: uuid("sender_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    parts: jsonb("parts").$type<MessagePart[]>(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("messages_conversation_id_idx").on(t.conversationId),
    index("messages_sender_id_idx").on(t.senderId),
    index("messages_created_at_idx").on(t.createdAt),
  ]
);

export const bots = pgTable(
  "bots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    webhookUrl: text("webhook_url"),
    webhookSecret: varchar("webhook_secret", { length: 128 }).notNull(),
    apiKey: varchar("api_key", { length: 128 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("bots_user_id_idx").on(t.userId),
    uniqueIndex("bots_api_key_idx").on(t.apiKey),
    index("bots_owner_id_idx").on(t.ownerId),
  ]
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: varchar("token", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [uniqueIndex("sessions_token_idx").on(t.token)]
);

export const workspaceProviderEnum = pgEnum("workspace_provider", [
  "openrouter",
  "codex",
]);

export const workspaceConfigs = pgTable("workspace_configs", {
  workspaceId: varchar("workspace_id", { length: 100 })
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  provider: workspaceProviderEnum("provider"),
  openrouterApiKey: text("openrouter_api_key"),
  openrouterModel: text("openrouter_model"),
  codexModel: text("codex_model"),
  reasoningEffort: varchar("reasoning_effort", { length: 20 }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

export const emailVerifications = pgTable(
  "email_verifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: varchar("token", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [uniqueIndex("email_verifications_token_idx").on(t.token)]
);

// -- Relations --

export const usersRelations = relations(users, ({ many }) => ({
  participations: many(conversationParticipants),
  messages: many(messages),
  sessions: many(sessions),
  emailVerifications: many(emailVerifications),
  workspaceMemberships: many(workspaceMembers),
  ownedBots: many(bots, { relationName: "botOwner" }),
}));

export const workspacesRelations = relations(workspaces, ({ one, many }) => ({
  createdBy: one(users, {
    fields: [workspaces.createdById],
    references: [users.id],
  }),
  members: many(workspaceMembers),
  conversations: many(conversations),
  config: one(workspaceConfigs, {
    fields: [workspaces.id],
    references: [workspaceConfigs.workspaceId],
  }),
}));

export const workspaceConfigsRelations = relations(
  workspaceConfigs,
  ({ one }) => ({
    workspace: one(workspaces, {
      fields: [workspaceConfigs.workspaceId],
      references: [workspaces.id],
    }),
  })
);

export const workspaceMembersRelations = relations(
  workspaceMembers,
  ({ one }) => ({
    workspace: one(workspaces, {
      fields: [workspaceMembers.workspaceId],
      references: [workspaces.id],
    }),
    user: one(users, {
      fields: [workspaceMembers.userId],
      references: [users.id],
    }),
  })
);

export const workspaceInvitesRelations = relations(
  workspaceInvites,
  ({ one }) => ({
    workspace: one(workspaces, {
      fields: [workspaceInvites.workspaceId],
      references: [workspaces.id],
    }),
    inviter: one(users, {
      fields: [workspaceInvites.inviterId],
      references: [users.id],
      relationName: "inviter",
    }),
    invitee: one(users, {
      fields: [workspaceInvites.inviteeId],
      references: [users.id],
      relationName: "invitee",
    }),
  })
);

export const conversationsRelations = relations(
  conversations,
  ({ one, many }) => ({
    participants: many(conversationParticipants),
    messages: many(messages),
    workspace: one(workspaces, {
      fields: [conversations.workspaceId],
      references: [workspaces.id],
    }),
  })
);

export const conversationParticipantsRelations = relations(
  conversationParticipants,
  ({ one }) => ({
    conversation: one(conversations, {
      fields: [conversationParticipants.conversationId],
      references: [conversations.id],
    }),
    user: one(users, {
      fields: [conversationParticipants.userId],
      references: [users.id],
    }),
  })
);

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
  sender: one(users, {
    fields: [messages.senderId],
    references: [users.id],
  }),
}));

export const botsRelations = relations(bots, ({ one }) => ({
  user: one(users, {
    fields: [bots.userId],
    references: [users.id],
    relationName: "botUser",
  }),
  owner: one(users, {
    fields: [bots.ownerId],
    references: [users.id],
    relationName: "botOwner",
  }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}));

export const emailVerificationsRelations = relations(
  emailVerifications,
  ({ one }) => ({
    user: one(users, {
      fields: [emailVerifications.userId],
      references: [users.id],
    }),
  })
);
