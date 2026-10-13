-- Tenant database hardening: preflight is fail-closed; no destructive repair.
-- All legacy writers must be quiesced. Locks make preflight and installation
-- atomic; the migrator runs this entire migration in a transaction.
LOCK TABLE workspaces, workspace_members, workspace_invites, conversations, conversation_participants, messages, conversation_threads, attachments, message_attachments, message_unreads, bot_invocations IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM messages m JOIN conversation_threads t ON t.id=m.thread_id WHERE m.conversation_id<>t.conversation_id) THEN
    RAISE EXCEPTION 'tenant preflight: messages/thread mismatch; repair explicitly before retry';
  END IF;
  IF EXISTS (SELECT 1 FROM message_unreads u JOIN messages m ON m.id=u.message_id WHERE u.conversation_id<>m.conversation_id) THEN
    RAISE EXCEPTION 'tenant preflight: unread/message mismatch; repair explicitly before retry';
  END IF;
  IF EXISTS (SELECT 1 FROM message_attachments l JOIN messages m ON m.id=l.message_id JOIN attachments a ON a.id=l.attachment_id WHERE m.conversation_id<>a.conversation_id) THEN
    RAISE EXCEPTION 'tenant preflight: attachment/message mismatch; repair explicitly before retry';
  END IF;
  IF EXISTS (
    SELECT 1 FROM bot_invocations i JOIN messages m ON m.id=i.trigger_message_id LEFT JOIN messages r ON r.id=i.response_message_id LEFT JOIN conversation_threads t ON t.id=i.thread_id
    WHERE i.conversation_id<>m.conversation_id OR i.thread_id IS DISTINCT FROM m.thread_id
      OR r.id IS NOT NULL AND (i.conversation_id<>r.conversation_id OR i.thread_id IS DISTINCT FROM r.thread_id)
      OR t.id IS NOT NULL AND (t.conversation_id<>i.conversation_id OR t.bot_id<>i.bot_id)
  ) OR EXISTS (SELECT 1 FROM conversation_threads c JOIN conversation_threads p ON p.id=c.branch_from_thread_id WHERE c.conversation_id<>p.conversation_id) THEN
    RAISE EXCEPTION 'tenant preflight: invocation/thread/message/branch mismatch; repair explicitly before retry';
  END IF;
END $$;

--> statement-breakpoint
CREATE FUNCTION thechat_actor() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('thechat.actor_id',true),'')::uuid
$$;
--> statement-breakpoint
CREATE FUNCTION thechat_scope_allows(workspace text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT public.thechat_actor() IS NOT NULL AND (
    current_setting('thechat.scope',true)='actor'
    OR workspace IS NOT NULL AND current_setting('thechat.scope',true)='workspace:'||workspace
    OR workspace IS NULL AND current_setting('thechat.scope',true)='personal'
  )
$$;
--> statement-breakpoint
CREATE FUNCTION thechat_can_workspace(workspace text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
  SELECT public.thechat_scope_allows(workspace) AND EXISTS (
    SELECT 1 FROM public.workspace_members m WHERE m.workspace_id=workspace AND m.user_id=public.thechat_actor()
  )
$$;
--> statement-breakpoint
CREATE FUNCTION thechat_can_conversation(conversation uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.conversations c WHERE c.id=conversation
      AND public.thechat_scope_allows(c.workspace_id)
      AND (c.workspace_id IS NULL OR public.thechat_can_workspace(c.workspace_id))
      AND (c.type='group' AND c.workspace_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM public.conversation_participants p WHERE p.conversation_id=c.id AND p.user_id=public.thechat_actor()
      ))
  )
$$;
--> statement-breakpoint
CREATE FUNCTION thechat_bootstrap_workspace(workspace text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
  SELECT public.thechat_scope_allows(workspace) AND EXISTS (SELECT 1 FROM public.workspaces w WHERE w.id=workspace AND w.created_by_id=public.thechat_actor() AND w.xmin::text=pg_current_xact_id_if_assigned()::text)
$$;
--> statement-breakpoint
CREATE FUNCTION thechat_manage_workspace(workspace text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
  SELECT public.thechat_scope_allows(workspace) AND (public.thechat_bootstrap_workspace(workspace) OR EXISTS (SELECT 1 FROM public.workspace_members m WHERE m.workspace_id=workspace AND m.user_id=public.thechat_actor() AND m.role IN ('owner','admin')))
$$;
--> statement-breakpoint
CREATE FUNCTION thechat_invited_workspace(workspace text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
  SELECT public.thechat_scope_allows(workspace) AND EXISTS (SELECT 1 FROM public.workspace_invites i WHERE i.workspace_id=workspace AND i.invitee_id=public.thechat_actor() AND i.status='pending')
$$;
--> statement-breakpoint
CREATE FUNCTION thechat_can_enroll(workspace text, target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
  SELECT public.thechat_manage_workspace(workspace) OR (public.thechat_scope_allows(workspace) AND target=public.thechat_actor() AND EXISTS (
    SELECT 1 FROM public.workspace_invites i JOIN public.workspace_members m ON m.workspace_id=i.workspace_id AND m.user_id=i.inviter_id
    WHERE i.workspace_id=workspace AND i.invitee_id=target AND i.status IN ('pending','accepted') AND m.role IN ('owner','admin')
  ))
$$;
--> statement-breakpoint
CREATE FUNCTION thechat_bootstrap_conversation(conversation uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
  SELECT EXISTS (SELECT 1 FROM public.conversations c WHERE c.id=conversation AND c.xmin::text=pg_current_xact_id_if_assigned()::text AND public.thechat_scope_allows(c.workspace_id) AND (c.workspace_id IS NULL OR public.thechat_can_workspace(c.workspace_id)))
$$;
--> statement-breakpoint
CREATE FUNCTION thechat_can_event(tenant text, partition text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN partition ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN public.thechat_can_conversation(partition::uuid) ELSE public.thechat_can_workspace(tenant) END
$$;
--> statement-breakpoint
CREATE FUNCTION thechat_check_invocation_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.bot_invocations i
    JOIN public.messages m ON m.id=i.trigger_message_id
    LEFT JOIN public.messages r ON r.id=i.response_message_id
    WHERE (TG_TABLE_NAME='bot_invocations' AND i.id=NEW.id OR TG_TABLE_NAME='messages' AND (i.trigger_message_id=NEW.id OR i.response_message_id=NEW.id))
    AND (i.thread_id IS DISTINCT FROM m.thread_id OR r.id IS NOT NULL AND i.thread_id IS DISTINCT FROM r.thread_id)
  ) THEN
    RAISE EXCEPTION 'invocation message thread mismatch' USING ERRCODE='23503', CONSTRAINT='bot_invocations_message_thread_scope';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
ALTER TABLE message_attachments ADD COLUMN conversation_id uuid DEFAULT NULL;
UPDATE message_attachments l SET conversation_id=m.conversation_id FROM messages m WHERE m.id=l.message_id;
CREATE FUNCTION thechat_fill_message_attachment_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.conversation_id IS NULL THEN
    SELECT m.conversation_id INTO NEW.conversation_id FROM public.messages m WHERE m.id=NEW.message_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER message_attachment_scope BEFORE INSERT ON message_attachments FOR EACH ROW EXECUTE FUNCTION thechat_fill_message_attachment_scope();
ALTER TABLE message_attachments ALTER COLUMN conversation_id SET NOT NULL;

--> statement-breakpoint
CREATE UNIQUE INDEX "attachments_id_conversation_idx" ON "attachments" USING btree ("id","conversation_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_threads_id_conversation_bot_idx" ON "conversation_threads" USING btree ("id","conversation_id","bot_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_threads_id_conversation_idx" ON "conversation_threads" USING btree ("id","conversation_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "messages_id_conversation_idx" ON "messages" USING btree ("id","conversation_id");
--> statement-breakpoint
CREATE INDEX "messages_conversation_order_idx" ON "messages" USING btree ("conversation_id","created_at","id");
--> statement-breakpoint
CREATE INDEX "messages_conversation_thread_order_idx" ON "messages" USING btree ("conversation_id","thread_id","created_at","id");
--> statement-breakpoint
ALTER TABLE "conversation_threads" DROP CONSTRAINT "conversation_threads_created_by_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "workspaces" DROP CONSTRAINT "workspaces_created_by_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "conversation_threads" ALTER COLUMN "created_by_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "workspaces" ALTER COLUMN "created_by_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "bot_invocations" ADD CONSTRAINT "bot_invocations_trigger_conversation_fk" FOREIGN KEY ("trigger_message_id","conversation_id") REFERENCES "public"."messages"("id","conversation_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "bot_invocations" ADD CONSTRAINT "bot_invocations_response_conversation_fk" FOREIGN KEY ("response_message_id","conversation_id") REFERENCES "public"."messages"("id","conversation_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "bot_invocations" ADD CONSTRAINT "bot_invocations_thread_conversation_bot_fk" FOREIGN KEY ("thread_id","conversation_id","bot_id") REFERENCES "public"."conversation_threads"("id","conversation_id","bot_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation_threads" ADD CONSTRAINT "conversation_threads_branch_conversation_fk" FOREIGN KEY ("branch_from_thread_id","conversation_id") REFERENCES "public"."conversation_threads"("id","conversation_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "conversation_threads" ADD CONSTRAINT "conversation_threads_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_message_conversation_fk" FOREIGN KEY ("message_id","conversation_id") REFERENCES "public"."messages"("id","conversation_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_attachment_conversation_fk" FOREIGN KEY ("attachment_id","conversation_id") REFERENCES "public"."attachments"("id","conversation_id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "message_unreads" ADD CONSTRAINT "message_unreads_message_conversation_fk" FOREIGN KEY ("message_id","conversation_id") REFERENCES "public"."messages"("id","conversation_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_conversation_fk" FOREIGN KEY ("thread_id","conversation_id") REFERENCES "public"."conversation_threads"("id","conversation_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "attachments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "bot_invocations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "bot_workspace_invites" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "conversation_participants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "conversation_threads" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "event_outbox" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "message_attachments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "message_reactions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "message_unreads" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workspace_configs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workspace_invites" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workspace_members" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "workspaces" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_access" ON "attachments" AS PERMISSIVE FOR ALL TO public USING (thechat_can_conversation(conversation_id)) WITH CHECK (thechat_can_conversation(conversation_id));
--> statement-breakpoint
CREATE POLICY "tenant_access" ON "bot_invocations" AS PERMISSIVE FOR ALL TO public USING (thechat_can_conversation(conversation_id)) WITH CHECK (thechat_can_conversation(conversation_id));
--> statement-breakpoint
CREATE POLICY "tenant_delete" ON "bot_workspace_invites" AS PERMISSIVE FOR DELETE TO public USING (thechat_manage_workspace((workspace_id)::text));
--> statement-breakpoint
CREATE POLICY "tenant_insert" ON "bot_workspace_invites" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((thechat_manage_workspace((workspace_id)::text) AND (requester_id = thechat_actor())));
--> statement-breakpoint
CREATE POLICY "tenant_read" ON "bot_workspace_invites" AS PERMISSIVE FOR SELECT TO public USING ((thechat_scope_allows((workspace_id)::text) AND (thechat_manage_workspace((workspace_id)::text) OR (EXISTS ( SELECT 1
   FROM bots b
  WHERE ((b.id = bot_workspace_invites.bot_id) AND (b.owner_id = thechat_actor())))))));
--> statement-breakpoint
CREATE POLICY "tenant_update" ON "bot_workspace_invites" AS PERMISSIVE FOR UPDATE TO public USING ((thechat_scope_allows((workspace_id)::text) AND (thechat_manage_workspace((workspace_id)::text) OR (EXISTS ( SELECT 1
   FROM bots b
  WHERE ((b.id = bot_workspace_invites.bot_id) AND (b.owner_id = thechat_actor()))))))) WITH CHECK ((thechat_scope_allows((workspace_id)::text) AND (thechat_manage_workspace((workspace_id)::text) OR (EXISTS ( SELECT 1
   FROM bots b
  WHERE ((b.id = bot_workspace_invites.bot_id) AND (b.owner_id = thechat_actor())))))));
--> statement-breakpoint
CREATE POLICY "tenant_access" ON "conversation_participants" AS PERMISSIVE FOR ALL TO public USING ((thechat_can_conversation(conversation_id) OR thechat_bootstrap_conversation(conversation_id))) WITH CHECK ((thechat_can_conversation(conversation_id) OR thechat_bootstrap_conversation(conversation_id)));
--> statement-breakpoint
CREATE POLICY "tenant_access" ON "conversation_threads" AS PERMISSIVE FOR ALL TO public USING (thechat_can_conversation(conversation_id)) WITH CHECK (thechat_can_conversation(conversation_id));
--> statement-breakpoint
CREATE POLICY "tenant_access" ON "conversations" AS PERMISSIVE FOR ALL TO public USING ((thechat_can_conversation(id) OR thechat_bootstrap_conversation(id))) WITH CHECK ((thechat_scope_allows((workspace_id)::text) AND (((workspace_id IS NULL) AND (type = 'direct'::conversation_type)) OR thechat_can_workspace((workspace_id)::text))));
--> statement-breakpoint
CREATE POLICY "tenant_access" ON "event_outbox" AS PERMISSIVE FOR ALL TO public USING (thechat_can_event((tenant_id)::text, (partition_key)::text)) WITH CHECK (thechat_can_event((tenant_id)::text, (partition_key)::text));
--> statement-breakpoint
CREATE POLICY "tenant_access" ON "message_attachments" AS PERMISSIVE FOR ALL TO public USING (thechat_can_conversation(conversation_id)) WITH CHECK (thechat_can_conversation(conversation_id));
--> statement-breakpoint
CREATE POLICY "tenant_access" ON "message_reactions" AS PERMISSIVE FOR ALL TO public USING ((EXISTS ( SELECT 1
   FROM messages m
  WHERE ((m.id = message_reactions.message_id) AND thechat_can_conversation(m.conversation_id))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM messages m
  WHERE ((m.id = message_reactions.message_id) AND thechat_can_conversation(m.conversation_id)))));
--> statement-breakpoint
CREATE POLICY "tenant_delete" ON "message_unreads" AS PERMISSIVE FOR DELETE TO public USING (((user_id = thechat_actor()) AND thechat_can_conversation(conversation_id)));
--> statement-breakpoint
CREATE POLICY "tenant_insert" ON "message_unreads" AS PERMISSIVE FOR INSERT TO public WITH CHECK (thechat_can_conversation(conversation_id));
--> statement-breakpoint
CREATE POLICY "tenant_read" ON "message_unreads" AS PERMISSIVE FOR SELECT TO public USING (((user_id = thechat_actor()) AND thechat_can_conversation(conversation_id)));
--> statement-breakpoint
CREATE POLICY "tenant_access" ON "messages" AS PERMISSIVE FOR ALL TO public USING (thechat_can_conversation(conversation_id)) WITH CHECK (thechat_can_conversation(conversation_id));
--> statement-breakpoint
CREATE POLICY "tenant_access" ON "workspace_configs" AS PERMISSIVE FOR ALL TO public USING (thechat_can_workspace((workspace_id)::text)) WITH CHECK (thechat_manage_workspace((workspace_id)::text));
--> statement-breakpoint
CREATE POLICY "tenant_delete" ON "workspace_invites" AS PERMISSIVE FOR DELETE TO public USING (thechat_manage_workspace((workspace_id)::text));
--> statement-breakpoint
CREATE POLICY "tenant_insert" ON "workspace_invites" AS PERMISSIVE FOR INSERT TO public WITH CHECK (((inviter_id = thechat_actor()) AND thechat_manage_workspace((workspace_id)::text)));
--> statement-breakpoint
CREATE POLICY "tenant_read" ON "workspace_invites" AS PERMISSIVE FOR SELECT TO public USING ((thechat_scope_allows((workspace_id)::text) AND ((invitee_id = thechat_actor()) OR thechat_manage_workspace((workspace_id)::text))));
--> statement-breakpoint
CREATE POLICY "tenant_update" ON "workspace_invites" AS PERMISSIVE FOR UPDATE TO public USING ((thechat_scope_allows((workspace_id)::text) AND ((invitee_id = thechat_actor()) OR thechat_manage_workspace((workspace_id)::text)))) WITH CHECK ((thechat_scope_allows((workspace_id)::text) AND ((invitee_id = thechat_actor()) OR thechat_manage_workspace((workspace_id)::text))));
--> statement-breakpoint
CREATE POLICY "tenant_delete" ON "workspace_members" AS PERMISSIVE FOR DELETE TO public USING ((thechat_manage_workspace((workspace_id)::text) OR (thechat_scope_allows((workspace_id)::text) AND (user_id = thechat_actor()))));
--> statement-breakpoint
CREATE POLICY "tenant_insert" ON "workspace_members" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((thechat_manage_workspace((workspace_id)::text) OR ((role = 'member'::workspace_member_role) AND thechat_can_enroll((workspace_id)::text, user_id))));
--> statement-breakpoint
CREATE POLICY "tenant_read" ON "workspace_members" AS PERMISSIVE FOR SELECT TO public USING ((thechat_can_workspace((workspace_id)::text) OR thechat_bootstrap_workspace((workspace_id)::text)));
--> statement-breakpoint
CREATE POLICY "tenant_update" ON "workspace_members" AS PERMISSIVE FOR UPDATE TO public USING (thechat_manage_workspace((workspace_id)::text)) WITH CHECK (thechat_manage_workspace((workspace_id)::text));
--> statement-breakpoint
CREATE POLICY "tenant_access" ON "workspaces" AS PERMISSIVE FOR SELECT TO public USING ((thechat_can_workspace((id)::text) OR thechat_bootstrap_workspace((id)::text) OR thechat_invited_workspace((id)::text)));
--> statement-breakpoint
CREATE POLICY "tenant_delete" ON "workspaces" AS PERMISSIVE FOR DELETE TO public USING (thechat_manage_workspace((id)::text));
--> statement-breakpoint
CREATE POLICY "tenant_insert" ON "workspaces" AS PERMISSIVE FOR INSERT TO public WITH CHECK ((thechat_scope_allows((id)::text) AND (created_by_id = thechat_actor())));
--> statement-breakpoint
CREATE POLICY "tenant_update" ON "workspaces" AS PERMISSIVE FOR UPDATE TO public USING ((thechat_can_workspace((id)::text) OR thechat_can_enroll((id)::text, thechat_actor()))) WITH CHECK (thechat_manage_workspace((id)::text));
--> statement-breakpoint
-- Null-safe structural FKs also fence concurrent message/invocation writes.
-- Empty text encodes null; it cannot collide with a real UUID thread ID.
ALTER TABLE messages ADD COLUMN thread_scope_id text GENERATED ALWAYS AS (coalesce(thread_id::text, '')) STORED;
ALTER TABLE bot_invocations ADD COLUMN thread_scope_id text GENERATED ALWAYS AS (coalesce(thread_id::text, '')) STORED;
CREATE UNIQUE INDEX messages_id_conversation_thread_scope_idx ON messages(id,conversation_id,thread_scope_id);
ALTER TABLE bot_invocations ADD CONSTRAINT bot_invocations_trigger_thread_scope_fk FOREIGN KEY(trigger_message_id,conversation_id,thread_scope_id) REFERENCES messages(id,conversation_id,thread_scope_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE bot_invocations ADD CONSTRAINT bot_invocations_response_thread_scope_fk FOREIGN KEY(response_message_id,conversation_id,thread_scope_id) REFERENCES messages(id,conversation_id,thread_scope_id) DEFERRABLE INITIALLY DEFERRED;

--> statement-breakpoint
CREATE CONSTRAINT TRIGGER invocation_message_thread_scope AFTER INSERT OR UPDATE ON bot_invocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION thechat_check_invocation_scope();
CREATE CONSTRAINT TRIGGER message_invocation_thread_scope AFTER UPDATE ON messages DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION thechat_check_invocation_scope();

--> statement-breakpoint
CREATE FUNCTION thechat_immutable_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE field text;
BEGIN
  -- Explicit maintenance/migration authority has no authenticated actor GUC.
  IF public.thechat_actor() IS NOT NULL THEN
    FOREACH field IN ARRAY TG_ARGV LOOP
      IF to_jsonb(NEW)->field IS DISTINCT FROM to_jsonb(OLD)->field THEN
        RAISE EXCEPTION 'collaboration ownership key is immutable: %.%',TG_TABLE_NAME,field USING ERRCODE='42501';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenant_immutable_scope BEFORE UPDATE ON workspaces FOR EACH ROW EXECUTE FUNCTION thechat_immutable_scope('id');
CREATE TRIGGER tenant_immutable_scope BEFORE UPDATE ON workspace_members FOR EACH ROW EXECUTE FUNCTION thechat_immutable_scope('workspace_id','user_id');
CREATE TRIGGER tenant_immutable_scope BEFORE UPDATE ON workspace_invites FOR EACH ROW EXECUTE FUNCTION thechat_immutable_scope('workspace_id','inviter_id','invitee_id');
CREATE TRIGGER tenant_immutable_scope BEFORE UPDATE ON conversations FOR EACH ROW EXECUTE FUNCTION thechat_immutable_scope('workspace_id');
CREATE TRIGGER tenant_immutable_scope BEFORE UPDATE ON conversation_participants FOR EACH ROW EXECUTE FUNCTION thechat_immutable_scope('conversation_id','user_id');
CREATE TRIGGER tenant_immutable_scope BEFORE UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION thechat_immutable_scope('conversation_id','sender_id');
CREATE TRIGGER tenant_immutable_scope BEFORE UPDATE ON conversation_threads FOR EACH ROW EXECUTE FUNCTION thechat_immutable_scope('conversation_id','bot_id');
CREATE TRIGGER tenant_immutable_scope BEFORE UPDATE ON attachments FOR EACH ROW EXECUTE FUNCTION thechat_immutable_scope('conversation_id','uploader_id');
CREATE TRIGGER tenant_immutable_scope BEFORE UPDATE ON message_attachments FOR EACH ROW EXECUTE FUNCTION thechat_immutable_scope('conversation_id','message_id','attachment_id');
CREATE TRIGGER tenant_immutable_scope BEFORE UPDATE ON bot_invocations FOR EACH ROW EXECUTE FUNCTION thechat_immutable_scope('conversation_id','bot_id','trigger_message_id');
CREATE TRIGGER tenant_immutable_scope BEFORE UPDATE ON bot_workspace_invites FOR EACH ROW EXECUTE FUNCTION thechat_immutable_scope('workspace_id','bot_id','requester_id');
CREATE TRIGGER tenant_immutable_scope BEFORE UPDATE ON event_outbox FOR EACH ROW EXECUTE FUNCTION thechat_immutable_scope('tenant_id','partition_key');


--> statement-breakpoint
-- Global identities remain discoverable by authenticated principals. Their
-- mutation/credential authority is separate: otherwise deleting a global user
-- or bot can use FK cascades to bypass collaboration RLS in another tenant.
CREATE FUNCTION thechat_has_actor() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT public.thechat_actor() IS NOT NULL AND (
    current_setting('thechat.scope',true) IN ('actor','personal') OR current_setting('thechat.scope',true) LIKE 'workspace:%'
  )
$$;
CREATE FUNCTION thechat_identity_authority() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname='thechat_identity_authority' AND pg_has_role(current_user,r.oid,'MEMBER'))
$$;
CREATE FUNCTION thechat_owns_bot_user(target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
  SELECT public.thechat_has_actor() AND EXISTS (SELECT 1 FROM public.bots b WHERE b.user_id=target AND b.owner_id=public.thechat_actor())
$$;
CREATE FUNCTION thechat_manage_bot(target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
  SELECT public.thechat_has_actor() AND EXISTS (SELECT 1 FROM public.bots b WHERE b.id=target AND b.owner_id=public.thechat_actor())
$$;
CREATE FUNCTION thechat_claim_bot_user(target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
  SELECT public.thechat_has_actor() AND EXISTS (SELECT 1 FROM public.users u WHERE u.id=target AND u.type='bot' AND u.xmin::text=pg_current_xact_id_if_assigned()::text)
$$;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON users FOR SELECT USING (thechat_has_actor() OR thechat_identity_authority());
CREATE POLICY tenant_insert ON users FOR INSERT WITH CHECK (thechat_identity_authority() OR thechat_has_actor() AND type='bot');
CREATE POLICY tenant_update ON users FOR UPDATE USING (thechat_identity_authority() OR thechat_has_actor() AND (id=thechat_actor() OR thechat_owns_bot_user(id))) WITH CHECK (thechat_identity_authority() OR thechat_has_actor() AND (id=thechat_actor() OR thechat_owns_bot_user(id)));
CREATE POLICY tenant_delete ON users FOR DELETE USING (thechat_identity_authority() OR thechat_has_actor() AND (id=thechat_actor() OR thechat_owns_bot_user(id)));
ALTER TABLE bots ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON bots FOR SELECT USING (thechat_has_actor() OR thechat_identity_authority());
CREATE POLICY tenant_insert ON bots FOR INSERT WITH CHECK (thechat_identity_authority() OR thechat_has_actor() AND owner_id=thechat_actor() AND thechat_claim_bot_user(user_id));
CREATE POLICY tenant_update ON bots FOR UPDATE USING (thechat_identity_authority() OR thechat_has_actor() AND owner_id=thechat_actor()) WITH CHECK (thechat_identity_authority() OR thechat_has_actor() AND owner_id=thechat_actor());
CREATE POLICY tenant_delete ON bots FOR DELETE USING (thechat_identity_authority() OR thechat_has_actor() AND owner_id=thechat_actor());
ALTER TABLE hermes_bot_configs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_access ON hermes_bot_configs USING (thechat_identity_authority() OR thechat_manage_bot(bot_id)) WITH CHECK (thechat_identity_authority() OR thechat_manage_bot(bot_id));
CREATE TRIGGER tenant_immutable_scope BEFORE UPDATE ON bots FOR EACH ROW EXECUTE FUNCTION thechat_immutable_scope('user_id','owner_id');
ALTER TABLE apikey ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON apikey FOR SELECT USING (thechat_identity_authority() OR thechat_has_actor() AND config_id='bot' AND thechat_owns_bot_user(reference_id));
CREATE POLICY tenant_insert ON apikey FOR INSERT WITH CHECK (thechat_identity_authority() OR thechat_has_actor() AND config_id='bot' AND thechat_owns_bot_user(reference_id) AND thechat_claim_bot_user(reference_id));
CREATE POLICY tenant_update ON apikey FOR UPDATE USING (thechat_identity_authority()) WITH CHECK (thechat_identity_authority());
CREATE POLICY tenant_delete ON apikey FOR DELETE USING (thechat_identity_authority());

--> statement-breakpoint
CREATE FUNCTION thechat_read_bot(target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
  SELECT public.thechat_has_actor() AND EXISTS (
    SELECT 1 FROM public.bots b WHERE b.id=target AND (
      b.owner_id=public.thechat_actor() OR b.user_id=public.thechat_actor()
      OR EXISTS (SELECT 1 FROM public.workspace_members actor JOIN public.workspace_members installed ON installed.workspace_id=actor.workspace_id
        WHERE actor.user_id=public.thechat_actor() AND installed.user_id=b.user_id AND public.thechat_scope_allows(actor.workspace_id))
      OR EXISTS (SELECT 1 FROM public.conversation_participants actor JOIN public.conversation_participants bot ON bot.conversation_id=actor.conversation_id JOIN public.conversations c ON c.id=actor.conversation_id
        WHERE actor.user_id=public.thechat_actor() AND bot.user_id=b.user_id AND c.workspace_id IS NULL AND public.thechat_scope_allows(NULL))
    )
  )
$$;
ALTER POLICY tenant_read ON bots USING (thechat_identity_authority() OR thechat_has_actor() AND owner_id=thechat_actor() OR thechat_read_bot(id));
-- Public global identity projection is separate from private connector rows.
-- A security-barrier owner view intentionally exposes only these public fields.
CREATE VIEW bot_identities WITH (security_barrier=true) AS
SELECT id,user_id,owner_id,kind,avatar_shape,avatar_color,created_at,updated_at FROM bots
WHERE thechat_has_actor() OR thechat_identity_authority() OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls));
