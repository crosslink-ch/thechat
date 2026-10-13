import { pgPolicy } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export interface CollaborationPolicyDefinition {
  name: string;
  command: "all" | "select" | "insert" | "update" | "delete";
  using: string | null;
  withCheck: string | null;
}

// Canonical PostgreSQL expressions from migration 0017. Keep schema, migration
// and startup verification in agreement when deliberately changing a policy.
export const collaborationPolicyDefinitions: Record<string, CollaborationPolicyDefinition[]> = {
  "apikey": [
    {
      "name": "tenant_delete",
      "command": "delete",
      "using": "thechat_identity_authority()",
      "withCheck": null
    },
    {
      "name": "tenant_insert",
      "command": "insert",
      "using": null,
      "withCheck": "(thechat_identity_authority() OR (thechat_has_actor() AND (config_id = 'bot'::text) AND thechat_owns_bot_user(reference_id) AND thechat_claim_bot_user(reference_id)))"
    },
    {
      "name": "tenant_read",
      "command": "select",
      "using": "(thechat_identity_authority() OR (thechat_has_actor() AND (config_id = 'bot'::text) AND thechat_owns_bot_user(reference_id)))",
      "withCheck": null
    },
    {
      "name": "tenant_update",
      "command": "update",
      "using": "thechat_identity_authority()",
      "withCheck": "thechat_identity_authority()"
    }
  ],
  "attachments": [
    {
      "name": "tenant_access",
      "command": "all",
      "using": "thechat_can_conversation(conversation_id)",
      "withCheck": "thechat_can_conversation(conversation_id)"
    }
  ],
  "bot_invocations": [
    {
      "name": "tenant_access",
      "command": "all",
      "using": "thechat_can_conversation(conversation_id)",
      "withCheck": "thechat_can_conversation(conversation_id)"
    }
  ],
  "bot_workspace_invites": [
    {
      "name": "tenant_delete",
      "command": "delete",
      "using": "thechat_manage_workspace((workspace_id)::text)",
      "withCheck": null
    },
    {
      "name": "tenant_insert",
      "command": "insert",
      "using": null,
      "withCheck": "(thechat_manage_workspace((workspace_id)::text) AND (requester_id = thechat_actor()))"
    },
    {
      "name": "tenant_read",
      "command": "select",
      "using": "(thechat_scope_allows((workspace_id)::text) AND (thechat_manage_workspace((workspace_id)::text) OR (EXISTS ( SELECT 1\n   FROM bots b\n  WHERE ((b.id = bot_workspace_invites.bot_id) AND (b.owner_id = thechat_actor()))))))",
      "withCheck": null
    },
    {
      "name": "tenant_update",
      "command": "update",
      "using": "(thechat_scope_allows((workspace_id)::text) AND (thechat_manage_workspace((workspace_id)::text) OR (EXISTS ( SELECT 1\n   FROM bots b\n  WHERE ((b.id = bot_workspace_invites.bot_id) AND (b.owner_id = thechat_actor()))))))",
      "withCheck": "(thechat_scope_allows((workspace_id)::text) AND (thechat_manage_workspace((workspace_id)::text) OR (EXISTS ( SELECT 1\n   FROM bots b\n  WHERE ((b.id = bot_workspace_invites.bot_id) AND (b.owner_id = thechat_actor()))))))"
    }
  ],
  "bots": [
    {
      "name": "tenant_delete",
      "command": "delete",
      "using": "(thechat_identity_authority() OR (thechat_has_actor() AND (owner_id = thechat_actor())))",
      "withCheck": null
    },
    {
      "name": "tenant_insert",
      "command": "insert",
      "using": null,
      "withCheck": "(thechat_identity_authority() OR (thechat_has_actor() AND (owner_id = thechat_actor()) AND thechat_claim_bot_user(user_id)))"
    },
    {
      "name": "tenant_read",
      "command": "select",
      "using": "(thechat_identity_authority() OR (thechat_has_actor() AND (owner_id = thechat_actor())) OR thechat_read_bot(id))",
      "withCheck": null
    },
    {
      "name": "tenant_update",
      "command": "update",
      "using": "(thechat_identity_authority() OR (thechat_has_actor() AND (owner_id = thechat_actor())))",
      "withCheck": "(thechat_identity_authority() OR (thechat_has_actor() AND (owner_id = thechat_actor())))"
    }
  ],
  "conversation_participants": [
    {
      "name": "tenant_access",
      "command": "all",
      "using": "(thechat_can_conversation(conversation_id) OR thechat_bootstrap_conversation(conversation_id))",
      "withCheck": "(thechat_can_conversation(conversation_id) OR thechat_bootstrap_conversation(conversation_id))"
    }
  ],
  "conversation_threads": [
    {
      "name": "tenant_access",
      "command": "all",
      "using": "thechat_can_conversation(conversation_id)",
      "withCheck": "thechat_can_conversation(conversation_id)"
    }
  ],
  "conversations": [
    {
      "name": "tenant_access",
      "command": "all",
      "using": "(thechat_can_conversation(id) OR thechat_bootstrap_conversation(id))",
      "withCheck": "(thechat_scope_allows((workspace_id)::text) AND (((workspace_id IS NULL) AND (type = 'direct'::conversation_type)) OR thechat_can_workspace((workspace_id)::text)))"
    }
  ],
  "event_outbox": [
    {
      "name": "tenant_access",
      "command": "all",
      "using": "thechat_can_event((tenant_id)::text, (partition_key)::text)",
      "withCheck": "thechat_can_event((tenant_id)::text, (partition_key)::text)"
    }
  ],
  "hermes_bot_configs": [
    {
      "name": "tenant_access",
      "command": "all",
      "using": "(thechat_identity_authority() OR thechat_manage_bot(bot_id))",
      "withCheck": "(thechat_identity_authority() OR thechat_manage_bot(bot_id))"
    }
  ],
  "message_attachments": [
    {
      "name": "tenant_access",
      "command": "all",
      "using": "thechat_can_conversation(conversation_id)",
      "withCheck": "thechat_can_conversation(conversation_id)"
    }
  ],
  "message_reactions": [
    {
      "name": "tenant_access",
      "command": "all",
      "using": "(EXISTS ( SELECT 1\n   FROM messages m\n  WHERE ((m.id = message_reactions.message_id) AND thechat_can_conversation(m.conversation_id))))",
      "withCheck": "(EXISTS ( SELECT 1\n   FROM messages m\n  WHERE ((m.id = message_reactions.message_id) AND thechat_can_conversation(m.conversation_id))))"
    }
  ],
  "message_unreads": [
    {
      "name": "tenant_delete",
      "command": "delete",
      "using": "((user_id = thechat_actor()) AND thechat_can_conversation(conversation_id))",
      "withCheck": null
    },
    {
      "name": "tenant_insert",
      "command": "insert",
      "using": null,
      "withCheck": "thechat_can_conversation(conversation_id)"
    },
    {
      "name": "tenant_read",
      "command": "select",
      "using": "((user_id = thechat_actor()) AND thechat_can_conversation(conversation_id))",
      "withCheck": null
    }
  ],
  "messages": [
    {
      "name": "tenant_access",
      "command": "all",
      "using": "thechat_can_conversation(conversation_id)",
      "withCheck": "thechat_can_conversation(conversation_id)"
    }
  ],
  "users": [
    {
      "name": "tenant_delete",
      "command": "delete",
      "using": "(thechat_identity_authority() OR (thechat_has_actor() AND ((id = thechat_actor()) OR thechat_owns_bot_user(id))))",
      "withCheck": null
    },
    {
      "name": "tenant_insert",
      "command": "insert",
      "using": null,
      "withCheck": "(thechat_identity_authority() OR (thechat_has_actor() AND (type = 'bot'::user_type)))"
    },
    {
      "name": "tenant_read",
      "command": "select",
      "using": "(thechat_has_actor() OR thechat_identity_authority())",
      "withCheck": null
    },
    {
      "name": "tenant_update",
      "command": "update",
      "using": "(thechat_identity_authority() OR (thechat_has_actor() AND ((id = thechat_actor()) OR thechat_owns_bot_user(id))))",
      "withCheck": "(thechat_identity_authority() OR (thechat_has_actor() AND ((id = thechat_actor()) OR thechat_owns_bot_user(id))))"
    }
  ],
  "workspace_configs": [
    {
      "name": "tenant_access",
      "command": "all",
      "using": "thechat_can_workspace((workspace_id)::text)",
      "withCheck": "thechat_manage_workspace((workspace_id)::text)"
    }
  ],
  "workspace_invites": [
    {
      "name": "tenant_delete",
      "command": "delete",
      "using": "thechat_manage_workspace((workspace_id)::text)",
      "withCheck": null
    },
    {
      "name": "tenant_insert",
      "command": "insert",
      "using": null,
      "withCheck": "((inviter_id = thechat_actor()) AND thechat_manage_workspace((workspace_id)::text))"
    },
    {
      "name": "tenant_read",
      "command": "select",
      "using": "(thechat_scope_allows((workspace_id)::text) AND ((invitee_id = thechat_actor()) OR thechat_manage_workspace((workspace_id)::text)))",
      "withCheck": null
    },
    {
      "name": "tenant_update",
      "command": "update",
      "using": "(thechat_scope_allows((workspace_id)::text) AND ((invitee_id = thechat_actor()) OR thechat_manage_workspace((workspace_id)::text)))",
      "withCheck": "(thechat_scope_allows((workspace_id)::text) AND ((invitee_id = thechat_actor()) OR thechat_manage_workspace((workspace_id)::text)))"
    }
  ],
  "workspace_members": [
    {
      "name": "tenant_delete",
      "command": "delete",
      "using": "(thechat_manage_workspace((workspace_id)::text) OR (thechat_scope_allows((workspace_id)::text) AND (user_id = thechat_actor())))",
      "withCheck": null
    },
    {
      "name": "tenant_insert",
      "command": "insert",
      "using": null,
      "withCheck": "(thechat_manage_workspace((workspace_id)::text) OR ((role = 'member'::workspace_member_role) AND thechat_can_enroll((workspace_id)::text, user_id)))"
    },
    {
      "name": "tenant_read",
      "command": "select",
      "using": "(thechat_can_workspace((workspace_id)::text) OR thechat_bootstrap_workspace((workspace_id)::text))",
      "withCheck": null
    },
    {
      "name": "tenant_update",
      "command": "update",
      "using": "thechat_manage_workspace((workspace_id)::text)",
      "withCheck": "thechat_manage_workspace((workspace_id)::text)"
    }
  ],
  "workspaces": [
    {
      "name": "tenant_access",
      "command": "select",
      "using": "(thechat_can_workspace((id)::text) OR thechat_bootstrap_workspace((id)::text) OR thechat_invited_workspace((id)::text))",
      "withCheck": null
    },
    {
      "name": "tenant_delete",
      "command": "delete",
      "using": "thechat_manage_workspace((id)::text)",
      "withCheck": null
    },
    {
      "name": "tenant_insert",
      "command": "insert",
      "using": null,
      "withCheck": "(thechat_scope_allows((id)::text) AND (created_by_id = thechat_actor()))"
    },
    {
      "name": "tenant_update",
      "command": "update",
      "using": "(thechat_can_workspace((id)::text) OR thechat_can_enroll((id)::text, thechat_actor()))",
      "withCheck": "thechat_manage_workspace((id)::text)"
    }
  ]
};

export function collaborationPolicies(table: string) {
  return collaborationPolicyDefinitions[table]!.map(policy => pgPolicy(policy.name, {
    for: policy.command,
    ...(policy.using ? { using: sql.raw(policy.using) } : {}),
    ...(policy.withCheck ? { withCheck: sql.raw(policy.withCheck) } : {}),
  }));
}
