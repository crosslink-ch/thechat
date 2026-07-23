import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
  boolean,
  integer,
  primaryKey,
  index,
  uniqueIndex,
  foreignKey,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import type { BotCommandPublic, MessagePart } from "@thechat/shared";
import type { DomainEventEnvelope } from "../events/envelope";

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
export const botKindEnum = pgEnum("bot_kind", ["webhook", "hermes"]);
export const attachmentStatusEnum = pgEnum("attachment_status", [
  "pending_upload",
  "processing",
  "ready",
  "attached",
  "rejected",
  "deleting",
  "deleted",
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
    threadId: uuid("thread_id").references(() => conversationThreads.id, {
      onDelete: "set null",
    }),
    senderId: uuid("sender_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientMessageId: varchar("client_message_id", { length: 255 }),
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
    index("messages_thread_id_idx").on(t.threadId),
    index("messages_sender_id_idx").on(t.senderId),
    index("messages_created_at_idx").on(t.createdAt),
    uniqueIndex("messages_sender_client_message_idx").on(
      t.senderId,
      t.clientMessageId,
    ),
  ]
);

export const eventOutbox = pgTable(
  "event_outbox",
  {
    id: uuid("id").primaryKey(),
    eventType: varchar("event_type", { length: 255 }).notNull(),
    eventVersion: integer("event_version").notNull(),
    aggregateType: varchar("aggregate_type", { length: 100 }).notNull(),
    aggregateId: varchar("aggregate_id", { length: 255 }).notNull(),
    actorType: varchar("actor_type", { length: 100 }),
    actorId: varchar("actor_id", { length: 255 }),
    tenantId: varchar("tenant_id", { length: 100 }),
    correlationId: varchar("correlation_id", { length: 255 }),
    causationId: varchar("causation_id", { length: 255 }),
    partitionKey: varchar("partition_key", { length: 255 }).notNull(),
    event: jsonb("event").$type<DomainEventEnvelope>().notNull(),
    availableAt: timestamp("available_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    deadAt: timestamp("dead_at", { withTimezone: true }),
    attempts: integer("attempts").default(0).notNull(),
    lastError: text("last_error"),
    lockedBy: varchar("locked_by", { length: 255 }),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("event_outbox_pending_idx").on(
      t.publishedAt,
      t.deadAt,
      t.availableAt,
      t.createdAt,
    ),
    index("event_outbox_lock_idx").on(t.publishedAt, t.deadAt, t.lockedAt),
    index("event_outbox_partition_order_idx").on(
      t.partitionKey,
      t.publishedAt,
      t.deadAt,
      t.createdAt,
      t.id,
    ),
    index("event_outbox_aggregate_idx").on(t.aggregateType, t.aggregateId),
    index("event_outbox_correlation_idx").on(t.correlationId),
    index("event_outbox_published_retention_idx").on(t.publishedAt),
  ],
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
    kind: botKindEnum("kind").notNull().default("webhook"),
    attachmentAccess: boolean("attachment_access").notNull().default(false),
    commandsJson: jsonb("commands_json").$type<BotCommandPublic[]>(),
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

export const hermesBotConfigs = pgTable("hermes_bot_configs", {
  botId: uuid("bot_id")
    .primaryKey()
    .references(() => bots.id, { onDelete: "cascade" }),
  baseUrl: text("base_url"),
  apiKeyEncrypted: text("api_key_encrypted"),
  defaultMode: varchar("default_mode", { length: 20 }).notNull().default("run"),
  defaultInstructions: text("default_instructions"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

export const botInvocations = pgTable(
  "bot_invocations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id").references(() => conversationThreads.id, {
      onDelete: "set null",
    }),
    triggerMessageId: uuid("trigger_message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    responseMessageId: uuid("response_message_id").references(
      () => messages.id,
      { onDelete: "set null" }
    ),
    adapterKind: varchar("adapter_kind", { length: 20 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("queued"),
    externalRunId: text("external_run_id"),
    requestJson: jsonb("request_json").$type<Record<string, unknown>>(),
    responseJson: jsonb("response_json").$type<Record<string, unknown>>(),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("bot_invocations_bot_id_idx").on(t.botId),
    index("bot_invocations_conversation_id_idx").on(t.conversationId),
    index("bot_invocations_thread_id_idx").on(t.threadId),
    index("bot_invocations_trigger_message_id_idx").on(t.triggerMessageId),
    index("bot_invocations_status_idx").on(t.status),
    uniqueIndex("bot_invocations_bot_trigger_idx").on(
      t.botId,
      t.triggerMessageId
    ),
  ]
);

export const conversationThreads = pgTable(
  "conversation_threads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bots.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 255 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    branchPending: boolean("branch_pending").notNull().default(false),
    branchFromThreadId: uuid("branch_from_thread_id"),
    createdById: uuid("created_by_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("conversation_threads_conversation_id_idx").on(t.conversationId),
    index("conversation_threads_bot_id_idx").on(t.botId),
    index("conversation_threads_conversation_activity_idx").on(
      t.conversationId,
      t.lastActivityAt,
      t.id,
    ),
    index("conversation_threads_last_activity_idx").on(t.lastActivityAt),
    foreignKey({
      name: "conversation_threads_branch_from_thread_id_fk",
      columns: [t.branchFromThreadId],
      foreignColumns: [t.id],
    }).onDelete("set null"),
  ],
);

/**
 * PostgreSQL is authoritative for attachment ownership and lifecycle. The
 * object-store coordinates below are private implementation details and must
 * never be serialized into messages, events, webhooks, or logs.
 */
export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    uploaderId: uuid("uploader_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    fileName: varchar("file_name", { length: 255 }).notNull(),
    declaredMediaType: varchar("declared_media_type", { length: 255 }).notNull(),
    declaredSizeBytes: integer("declared_size_bytes").notNull(),
    declaredChecksumSha256: varchar("declared_checksum_sha256", {
      length: 64,
    }).notNull(),
    verifiedMediaType: varchar("verified_media_type", { length: 255 }),
    verifiedSizeBytes: integer("verified_size_bytes"),
    verifiedChecksumSha256: varchar("verified_checksum_sha256", {
      length: 64,
    }),
    width: integer("width"),
    height: integer("height"),
    status: attachmentStatusEnum("status")
      .notNull()
      .default("pending_upload"),
    quarantineKey: text("quarantine_key").notNull(),
    quarantineVersionId: text("quarantine_version_id"),
    cleanKey: text("clean_key"),
    cleanVersionId: text("clean_version_id"),
    failureReason: varchar("failure_reason", { length: 255 }),
    uploadExpiresAt: timestamp("upload_expires_at", { withTimezone: true })
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    processingAt: timestamp("processing_at", { withTimezone: true }),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    attachedAt: timestamp("attached_at", { withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    deletingAt: timestamp("deleting_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("attachments_conversation_idx").on(t.conversationId),
    index("attachments_uploader_idx").on(t.uploaderId),
    index("attachments_status_expiry_idx").on(t.status, t.expiresAt),
  ],
);

export const messageAttachments = pgTable(
  "message_attachments",
  {
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    attachmentId: uuid("attachment_id")
      .notNull()
      .references(() => attachments.id, { onDelete: "restrict" }),
    position: integer("position").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.position] }),
    uniqueIndex("message_attachments_attachment_idx").on(t.attachmentId),
    uniqueIndex("message_attachments_message_attachment_idx").on(
      t.messageId,
      t.attachmentId,
    ),
  ],
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
  "glm",
  "featherless",
]);

export const workspaceConfigs = pgTable("workspace_configs", {
  workspaceId: varchar("workspace_id", { length: 100 })
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  provider: workspaceProviderEnum("provider"),
  openrouterApiKey: text("openrouter_api_key"),
  openrouterModel: text("openrouter_model"),
  codexModel: text("codex_model"),
  glmApiKey: text("glm_api_key"),
  glmModel: text("glm_model"),
  featherlessApiKey: text("featherless_api_key"),
  featherlessModel: text("featherless_model"),
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
    code: varchar("code", { length: 6 }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  // One outstanding code per user — resends delete the previous row first.
  (t) => [uniqueIndex("email_verifications_user_id_idx").on(t.userId)]
);

// -- Relations --

export const usersRelations = relations(users, ({ many }) => ({
  participations: many(conversationParticipants),
  messages: many(messages),
  sessions: many(sessions),
  emailVerifications: many(emailVerifications),
  workspaceMemberships: many(workspaceMembers),
  ownedBots: many(bots, { relationName: "botOwner" }),
  uploadedAttachments: many(attachments),
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
    threads: many(conversationThreads),
    attachments: many(attachments),
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

export const messagesRelations = relations(messages, ({ one, many }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
  thread: one(conversationThreads, {
    fields: [messages.threadId],
    references: [conversationThreads.id],
  }),
  sender: one(users, {
    fields: [messages.senderId],
    references: [users.id],
  }),
  attachments: many(messageAttachments),
}));

export const attachmentsRelations = relations(
  attachments,
  ({ one, many }) => ({
    conversation: one(conversations, {
      fields: [attachments.conversationId],
      references: [conversations.id],
    }),
    uploader: one(users, {
      fields: [attachments.uploaderId],
      references: [users.id],
    }),
    messageLinks: many(messageAttachments),
  }),
);

export const messageAttachmentsRelations = relations(
  messageAttachments,
  ({ one }) => ({
    message: one(messages, {
      fields: [messageAttachments.messageId],
      references: [messages.id],
    }),
    attachment: one(attachments, {
      fields: [messageAttachments.attachmentId],
      references: [attachments.id],
    }),
  }),
);

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

export const botInvocationsRelations = relations(
  botInvocations,
  ({ one }) => ({
    bot: one(bots, {
      fields: [botInvocations.botId],
      references: [bots.id],
    }),
    conversation: one(conversations, {
      fields: [botInvocations.conversationId],
      references: [conversations.id],
    }),
    thread: one(conversationThreads, {
      fields: [botInvocations.threadId],
      references: [conversationThreads.id],
    }),
    triggerMessage: one(messages, {
      fields: [botInvocations.triggerMessageId],
      references: [messages.id],
    }),
    responseMessage: one(messages, {
      fields: [botInvocations.responseMessageId],
      references: [messages.id],
    }),
  })
);

export const conversationThreadsRelations = relations(
  conversationThreads,
  ({ one, many }) => ({
    conversation: one(conversations, {
      fields: [conversationThreads.conversationId],
      references: [conversations.id],
    }),
    bot: one(bots, {
      fields: [conversationThreads.botId],
      references: [bots.id],
    }),
    createdBy: one(users, {
      fields: [conversationThreads.createdById],
      references: [users.id],
    }),
    messages: many(messages),
    invocations: many(botInvocations),
  }),
);

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
