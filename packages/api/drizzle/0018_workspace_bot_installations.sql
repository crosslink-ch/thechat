ALTER TABLE "bots" ADD COLUMN "endpoint_revision" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
CREATE TABLE "bot_installation_channels" (
	"workspace_id" varchar(100) NOT NULL,
	"bot_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	CONSTRAINT "bot_installation_channels_workspace_id_bot_id_conversation_id_pk" PRIMARY KEY("workspace_id","bot_id","conversation_id")
);
--> statement-breakpoint
CREATE TABLE "bot_workspace_installations" (
	"workspace_id" varchar(100) NOT NULL,
	"bot_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"channel_scope" varchar(20) DEFAULT 'selected' NOT NULL,
	"attachment_access" boolean DEFAULT false NOT NULL,
	"shared_runtime_consent" boolean DEFAULT false NOT NULL,
	"approved_endpoint_url" text,
	"approved_endpoint_revision" integer DEFAULT 1 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"approved_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_workspace_installations_workspace_id_bot_id_pk" PRIMARY KEY("workspace_id","bot_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_workspace_id_id_idx" ON "conversations" USING btree ("workspace_id","id");
--> statement-breakpoint
ALTER TABLE "bot_installation_channels" ADD CONSTRAINT "bot_installation_channels_workspace_id_bot_id_bot_workspace_installations_workspace_id_bot_id_fk" FOREIGN KEY ("workspace_id","bot_id") REFERENCES "public"."bot_workspace_installations"("workspace_id","bot_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_installation_channels" ADD CONSTRAINT "bot_installation_channels_workspace_id_conversation_id_conversations_workspace_id_id_fk" FOREIGN KEY ("workspace_id","conversation_id") REFERENCES "public"."conversations"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_workspace_installations" ADD CONSTRAINT "bot_workspace_installations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_workspace_installations" ADD CONSTRAINT "bot_workspace_installations_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_workspace_installations" ADD CONSTRAINT "bot_workspace_installations_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- Explicit compatibility backfill: prior administrator-approved memberships retain
-- workspace-wide scope, existing global attachment ceiling and the current endpoint.
-- This is a one-time migration, never a permission-on-absence runtime fallback.
INSERT INTO bot_workspace_installations (workspace_id,bot_id,enabled,channel_scope,attachment_access,shared_runtime_consent,approved_endpoint_url,approved_endpoint_revision,revision)
SELECT wm.workspace_id,b.id,true,'all',b.attachment_access,true,b.webhook_url,1,1
FROM workspace_members wm JOIN bots b ON b.user_id=wm.user_id;

--> statement-breakpoint
-- Installation authority is independent from global bot ownership.
CREATE FUNCTION thechat_installation_owner(workspace text, target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
 SELECT public.thechat_scope_allows(workspace) AND EXISTS (SELECT 1 FROM public.bots b WHERE b.id=target AND b.owner_id=public.thechat_actor())
$$;
--> statement-breakpoint
ALTER TABLE bot_workspace_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_installation_channels ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_read ON bot_workspace_installations FOR SELECT USING (thechat_can_workspace(workspace_id) OR thechat_installation_owner(workspace_id,bot_id));
CREATE POLICY tenant_insert ON bot_workspace_installations FOR INSERT WITH CHECK (thechat_manage_workspace(workspace_id));
CREATE POLICY tenant_update ON bot_workspace_installations FOR UPDATE USING (thechat_manage_workspace(workspace_id)) WITH CHECK (thechat_manage_workspace(workspace_id));
CREATE POLICY tenant_delete ON bot_workspace_installations FOR DELETE USING (thechat_manage_workspace(workspace_id));
CREATE POLICY tenant_read ON bot_installation_channels FOR SELECT USING (thechat_can_workspace(workspace_id) OR thechat_installation_owner(workspace_id,bot_id));
CREATE POLICY tenant_insert ON bot_installation_channels FOR INSERT WITH CHECK (thechat_manage_workspace(workspace_id));
CREATE POLICY tenant_delete ON bot_installation_channels FOR DELETE USING (thechat_manage_workspace(workspace_id));

--> statement-breakpoint
-- Narrow global-owner consent RPC. It can enroll only the requested bot after
-- locking and revalidating the approving human admin. It returns identifiers,
-- never customer messages, files, channels or private connector secrets.
CREATE FUNCTION thechat_resolve_bot_installation_invite(target uuid, decision text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE i public.bot_workspace_invites%ROWTYPE; b public.bots%ROWTYPE; u public.users%ROWTYPE;
 joined timestamptz; targets jsonb; e jsonb; envelope jsonb; event_id uuid; member_event jsonb;
BEGIN
 IF decision NOT IN ('accepted','declined') THEN RAISE EXCEPTION 'Invalid bot consent decision' USING ERRCODE='22023'; END IF;
 SELECT * INTO i FROM public.bot_workspace_invites WHERE id=target;
 IF NOT FOUND THEN RAISE EXCEPTION 'Bot approval request not found' USING ERRCODE='P0002'; END IF;
 SELECT * INTO b FROM public.bots WHERE id=i.bot_id;
 IF NOT public.thechat_has_actor() OR NOT public.thechat_scope_allows(i.workspace_id) OR b.owner_id<>public.thechat_actor() THEN
  RAISE EXCEPTION 'Only the bot owner can resolve this request' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.workspaces WHERE id=i.workspace_id FOR UPDATE;
 SELECT * INTO i FROM public.bot_workspace_invites WHERE id=target FOR UPDATE;
 IF i.status<>'pending' THEN RAISE EXCEPTION 'Bot approval request is no longer pending' USING ERRCODE='P0001'; END IF;
 IF decision='accepted' AND NOT EXISTS(SELECT 1 FROM public.workspace_members m JOIN public.users a ON a.id=m.user_id
  WHERE m.workspace_id=i.workspace_id AND m.user_id=i.requester_id AND m.role IN ('owner','admin') AND a.type='human') THEN
  RAISE EXCEPTION 'The requester is no longer a workspace admin' USING ERRCODE='P0001'; END IF;
 UPDATE public.bot_workspace_invites SET status=decision::public.bot_workspace_invite_status,updated_at=now() WHERE id=target;
 SELECT coalesce(jsonb_agg(m.user_id),'[]'::jsonb) INTO targets FROM public.workspace_members m JOIN public.users h ON h.id=m.user_id WHERE m.workspace_id=i.workspace_id AND h.type='human';
 IF decision='accepted' THEN
  INSERT INTO public.bot_workspace_installations(workspace_id,bot_id,enabled,channel_scope,attachment_access,shared_runtime_consent,approved_endpoint_url,approved_endpoint_revision,approved_by_id)
   VALUES(i.workspace_id,b.id,true,'all',b.attachment_access,true,b.webhook_url,b.endpoint_revision,i.requester_id) ON CONFLICT DO NOTHING;
  INSERT INTO public.workspace_members(workspace_id,user_id,role) VALUES(i.workspace_id,b.user_id,'member') ON CONFLICT DO NOTHING RETURNING joined_at INTO joined;
  INSERT INTO public.conversation_participants(conversation_id,user_id,role) SELECT id,b.user_id,'member' FROM public.conversations WHERE workspace_id=i.workspace_id AND type='group' ON CONFLICT DO NOTHING;
  IF joined IS NOT NULL THEN
   SELECT * INTO u FROM public.users WHERE id=b.user_id;
   member_event=jsonb_build_object('type','member_joined','workspaceId',i.workspace_id,'member',jsonb_build_object('userId',b.user_id,'role','member','joinedAt',to_char(joined at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
     'user',jsonb_build_object('id',b.user_id,'name',u.name,'email',null,'avatar',null,'type','bot'),'bot',jsonb_build_object('id',b.id,'kind',b.kind,'avatar',jsonb_build_object('shape',coalesce(b.avatar_shape,'bot'),'color',coalesce(b.avatar_color,'#6366f1')))));
  END IF;
 END IF;
 e=jsonb_build_object('type','bot_workspace_invite_resolved','inviteId',i.id,'workspaceId',i.workspace_id,'botId',b.id,'status',decision);
 FOR e IN SELECT e UNION ALL SELECT member_event WHERE member_event IS NOT NULL LOOP
  event_id=gen_random_uuid();
  envelope=jsonb_build_object('id',event_id,'type','workspace.lifecycle.notification','version',1,'aggregate',jsonb_build_object('type','workspace','id',i.workspace_id),'tenant',jsonb_build_object('workspaceId',i.workspace_id),'actor',jsonb_build_object('type','system','id','thechat'),'occurredAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
   'payload',jsonb_build_object('targetUserIds',targets||jsonb_build_array(i.requester_id,b.owner_id),'event',e));
  INSERT INTO public.event_outbox(id,event_type,event_version,aggregate_type,aggregate_id,tenant_id,actor_type,actor_id,partition_key,event)
   VALUES(event_id,'workspace.lifecycle.notification',1,'workspace',i.workspace_id,i.workspace_id,'system','thechat','workspace-lifecycle:'||i.workspace_id,envelope);
 END LOOP;
 RETURN jsonb_build_object('success',true,'workspaceId',i.workspace_id,'botId',b.id);
END $$;

--> statement-breakpoint
CREATE FUNCTION thechat_inviter_authorized(target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
 SELECT public.thechat_has_actor() AND EXISTS(SELECT 1 FROM public.workspace_invites i JOIN public.workspace_members m ON m.workspace_id=i.workspace_id AND m.user_id=i.inviter_id JOIN public.users u ON u.id=m.user_id
  WHERE i.id=target AND i.invitee_id=public.thechat_actor() AND i.status='pending' AND public.thechat_scope_allows(i.workspace_id) AND m.role IN ('owner','admin') AND u.type='human')
$$;
ALTER POLICY tenant_update ON workspaces USING (thechat_can_workspace(id::text) OR thechat_invited_workspace(id::text)) WITH CHECK (thechat_manage_workspace(id::text));

--> statement-breakpoint
CREATE FUNCTION thechat_update_own_bot_endpoint(target uuid, endpoint text) RETURNS TABLE(id uuid,user_id uuid,kind public.bot_kind,webhook_secret text)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
 UPDATE public.bots b SET webhook_url=endpoint, endpoint_revision=CASE WHEN b.webhook_url IS DISTINCT FROM endpoint THEN b.endpoint_revision+1 ELSE b.endpoint_revision END,updated_at=now()
 WHERE b.user_id=target AND target=public.thechat_actor() AND public.thechat_has_actor()
 RETURNING b.id,b.user_id,b.kind,b.webhook_secret
$$;

--> statement-breakpoint
-- Customer members can see scoped runtime metadata, never another owner's
-- global signing secret. The API obtains a signature, not credential material.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
ALTER POLICY tenant_read ON bots USING (thechat_identity_authority() OR thechat_has_actor() AND (owner_id=thechat_actor() OR user_id=thechat_actor()));
CREATE VIEW bot_runtime_metadata WITH (security_barrier=true) AS
 SELECT id,user_id,owner_id,webhook_url,endpoint_revision,kind,attachment_access,commands_json,avatar_shape,avatar_color,created_at,updated_at
 FROM bots WHERE thechat_read_bot(id) OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=CASE WHEN current_setting('role',true) IS DISTINCT FROM 'none' THEN current_setting('role',true) ELSE session_user END AND (rolsuper OR rolbypassrls));
CREATE FUNCTION thechat_lock_bot_endpoint(target uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
BEGIN
 IF NOT public.thechat_read_bot(target) AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=CASE WHEN current_setting('role',true) IS DISTINCT FROM 'none' THEN current_setting('role',true) ELSE session_user END AND rolbypassrls AND NOT rolsuper) THEN RAISE EXCEPTION 'Bot endpoint access denied' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM public.bots WHERE id=target FOR SHARE;
END $$;
CREATE FUNCTION thechat_sign_invocation(target uuid, body text, stamp bigint) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE i public.bot_invocations%ROWTYPE; b public.bots%ROWTYPE; c public.conversations%ROWTYPE; sender uuid; maintenance boolean;
BEGIN
 SELECT * INTO i FROM public.bot_invocations WHERE id=target;
 IF NOT FOUND OR i.status NOT IN ('running','claimed') OR i.response_json->'completion' IS NOT NULL THEN RETURN NULL; END IF;
 SELECT * INTO b FROM public.bots WHERE id=i.bot_id FOR SHARE;
 SELECT * INTO c FROM public.conversations WHERE id=i.conversation_id;
 SELECT sender_id INTO sender FROM public.messages WHERE id=i.trigger_message_id;
 SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=CASE WHEN current_setting('role',true) IS DISTINCT FROM 'none' THEN current_setting('role',true) ELSE session_user END AND rolbypassrls AND NOT rolsuper) INTO maintenance;
 IF NOT maintenance AND (NOT public.thechat_can_conversation(c.id) OR
  (public.thechat_actor() IS DISTINCT FROM sender AND public.thechat_actor() IS DISTINCT FROM b.user_id AND NOT EXISTS
   (SELECT 1 FROM public.conversation_participants participant WHERE participant.conversation_id=c.id AND participant.user_id=public.thechat_actor()
    AND body::jsonb->>'type'='thechat.hermes_platform.interaction' AND body::jsonb#>>'{interaction,requestType}' IN ('approval.request','clarify.request')))) THEN RETURN NULL; END IF;
 IF c.workspace_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.bot_workspace_installations g JOIN public.workspace_members m ON m.workspace_id=g.workspace_id AND m.user_id=b.user_id
  WHERE g.workspace_id=c.workspace_id AND g.bot_id=b.id AND g.enabled AND g.shared_runtime_consent AND g.approved_endpoint_url IS NOT DISTINCT FROM b.webhook_url AND g.approved_endpoint_revision=b.endpoint_revision
  AND (i.request_json->>'installationRevision')::integer=g.revision
  AND (g.channel_scope='all' OR EXISTS(SELECT 1 FROM public.bot_installation_channels x WHERE x.workspace_id=g.workspace_id AND x.bot_id=g.bot_id AND x.conversation_id=c.id))) THEN RETURN NULL; END IF;
  IF c.workspace_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.workspace_work w WHERE w.workspace_id=c.workspace_id AND w.kind='bot' AND w.idempotency_key=i.id::text
  AND w.state='running' AND w.lease_token::text=i.request_json->>'workToken' AND w.lease_until>clock_timestamp()) THEN RETURN NULL; END IF;
  RETURN encode(public.hmac(convert_to(stamp::text||'.'||body,'UTF8'),convert_to(b.webhook_secret,'UTF8'),'sha256'),'hex');
END $$;
-- These narrow global operations mutate only the authenticated bot's public
-- command metadata; neither can alter workspace installation grants.
CREATE FUNCTION thechat_update_own_bot_commands(target uuid, commands jsonb) RETURNS TABLE(id uuid,user_id uuid,kind public.bot_kind,commands_json jsonb) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
 UPDATE public.bots b SET commands_json=commands,updated_at=now() WHERE b.user_id=target AND target=public.thechat_actor() AND public.thechat_has_actor() RETURNING b.id,b.user_id,b.kind,b.commands_json
$$;
CREATE FUNCTION thechat_bot_has_dependencies(target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
 SELECT EXISTS(SELECT 1 FROM public.bots b WHERE b.id=target AND b.owner_id=public.thechat_actor() AND (
  EXISTS(SELECT 1 FROM public.workspace_members m WHERE m.user_id=b.user_id) OR EXISTS(SELECT 1 FROM public.bot_workspace_invites i WHERE i.bot_id=b.id AND i.status='pending')
  OR EXISTS(SELECT 1 FROM public.conversation_threads t JOIN public.conversations c ON c.id=t.conversation_id WHERE t.bot_id=b.id AND c.workspace_id IS NOT NULL)
  OR EXISTS(SELECT 1 FROM public.messages m JOIN public.conversations c ON c.id=m.conversation_id WHERE m.sender_id=b.user_id AND c.workspace_id IS NOT NULL)
 ))
$$;
--> statement-breakpoint
-- This projection exposes invitation metadata, not workspace content authority.
CREATE VIEW bot_invite_metadata WITH (security_barrier=true) AS
 SELECT i.id,i.workspace_id,w.name AS workspace_name,i.bot_id,b.user_id AS bot_user_id,
 u.name AS bot_name,b.avatar_shape AS bot_avatar_shape,b.avatar_color AS bot_avatar_color,
 i.requester_id,r.name AS requester_name,i.status,i.created_at,b.owner_id
 FROM bot_workspace_invites i JOIN workspaces w ON w.id=i.workspace_id
 JOIN bots b ON b.id=i.bot_id JOIN users u ON u.id=b.user_id JOIN users r ON r.id=i.requester_id
 WHERE thechat_has_actor() AND thechat_scope_allows(i.workspace_id)
 AND (b.owner_id=thechat_actor() OR thechat_manage_workspace(i.workspace_id));
CREATE FUNCTION thechat_bot_inviter_authorized(target uuid) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE i public.bot_workspace_invites%ROWTYPE;
BEGIN
 SELECT x.* INTO i FROM public.bot_workspace_invites x JOIN public.bots b ON b.id=x.bot_id
 WHERE x.id=target AND public.thechat_has_actor() AND public.thechat_scope_allows(x.workspace_id)
 AND (b.owner_id=public.thechat_actor() OR public.thechat_manage_workspace(x.workspace_id));
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM 1 FROM public.workspaces WHERE id=i.workspace_id FOR SHARE;
 RETURN i.status='pending' AND EXISTS(SELECT 1 FROM public.workspace_members m JOIN public.users u ON u.id=m.user_id
 WHERE m.workspace_id=i.workspace_id AND m.user_id=i.requester_id AND m.role IN ('owner','admin') AND u.type='human');
END $$;
--> statement-breakpoint
-- Direct SQL access intersects current installations as defense in depth.
-- Human workspace-wide channel compatibility is unchanged.
CREATE OR REPLACE FUNCTION thechat_can_workspace(workspace text) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
 SELECT public.thechat_scope_allows(workspace) AND EXISTS (
  SELECT 1 FROM public.workspace_members m JOIN public.users u ON u.id=m.user_id
  WHERE m.workspace_id=workspace AND m.user_id=public.thechat_actor()
  AND (u.type='human' OR EXISTS (
   SELECT 1 FROM public.bots b JOIN public.bot_workspace_installations g ON g.bot_id=b.id
   WHERE b.user_id=u.id AND g.workspace_id=workspace AND g.enabled AND g.shared_runtime_consent
  ))
 )
$$;
CREATE OR REPLACE FUNCTION thechat_can_conversation(conversation uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
 SELECT EXISTS (
  SELECT 1 FROM public.conversations c
  WHERE c.id=conversation AND public.thechat_scope_allows(c.workspace_id)
  AND (c.workspace_id IS NULL OR public.thechat_can_workspace(c.workspace_id))
  AND (c.type='group' AND c.workspace_id IS NOT NULL OR EXISTS (
   SELECT 1 FROM public.conversation_participants p WHERE p.conversation_id=c.id AND p.user_id=public.thechat_actor()
  ))
  AND (c.workspace_id IS NULL OR EXISTS (SELECT 1 FROM public.users u WHERE u.id=public.thechat_actor() AND u.type='human')
   OR EXISTS (SELECT 1 FROM public.bots b JOIN public.bot_workspace_installations g ON g.bot_id=b.id
    WHERE b.user_id=public.thechat_actor() AND g.workspace_id=c.workspace_id AND g.enabled AND g.shared_runtime_consent
    AND (g.channel_scope='all' OR EXISTS (SELECT 1 FROM public.bot_installation_channels x
     WHERE x.workspace_id=g.workspace_id AND x.bot_id=g.bot_id AND x.conversation_id=c.id))))
 )
$$;

--> statement-breakpoint
-- New narrow RPCs must not rely on PUBLIC execution during the role cutover.
DO $$ DECLARE fn regprocedure; BEGIN
 FOR fn IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'thechat_%'
 LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn); END LOOP;
END $$;
