CREATE TABLE workspace_resource_limits (
  workspace_id varchar(100) PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  retained_bytes bigint NOT NULL CHECK (retained_bytes > 0),
  pending_validation integer NOT NULL CHECK (pending_validation > 0),
  pending_bot integer NOT NULL CHECK (pending_bot > 0),
  concurrent_validation integer NOT NULL CHECK (concurrent_validation > 0),
  concurrent_bot integer NOT NULL CHECK (concurrent_bot > 0)
);
--> statement-breakpoint
CREATE TABLE workspace_work (
  workspace_id varchar(100) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind varchar(20) NOT NULL CHECK(kind IN ('validation','bot')),
  idempotency_key text NOT NULL,
  state varchar(20) NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','completed','cancelled')),
  lease_token uuid,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,kind,idempotency_key),
  CHECK ((state='running')=(lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX workspace_work_admission_idx ON workspace_work(workspace_id,kind,state,created_at,idempotency_key);
--> statement-breakpoint
-- Explicit retention starts at binding, not upload reservation.
ALTER TABLE attachments ADD COLUMN retention_seconds integer CHECK (retention_seconds > 0);
ALTER TABLE attachments ADD COLUMN retained_until timestamptz;
CREATE INDEX attachments_retained_until_idx ON attachments(retained_until) WHERE status='attached';
CREATE FUNCTION bind_attachment_retention() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='attached' AND OLD.status<>'attached' AND NEW.retention_seconds IS NOT NULL THEN
    NEW.retained_until := NEW.attached_at + NEW.retention_seconds * interval '1 second';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER attachments_retention_before_bind BEFORE UPDATE ON attachments FOR EACH ROW EXECUTE FUNCTION bind_attachment_retention();
--> statement-breakpoint
CREATE TABLE workspace_attachment_charges (
  attachment_id uuid PRIMARY KEY,
  workspace_id varchar(100) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  bytes bigint NOT NULL CHECK(bytes > 0),
  capability_until timestamptz NOT NULL,
  cleanup_requested boolean NOT NULL DEFAULT false,
  released_at timestamptz
);
CREATE INDEX workspace_attachment_charges_usage_idx ON workspace_attachment_charges(workspace_id,released_at);
INSERT INTO workspace_attachment_charges(attachment_id,workspace_id,bytes,capability_until,cleanup_requested,released_at)
SELECT a.id,c.workspace_id,a.declared_size_bytes,a.upload_expires_at,a.status IN ('deleting','rejected','deleted'),
  CASE WHEN a.deleted_at IS NOT NULL THEN a.deleted_at END
FROM attachments a JOIN conversations c ON c.id=a.conversation_id WHERE c.workspace_id IS NOT NULL;
CREATE FUNCTION account_attachment_charge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO workspace_attachment_charges(attachment_id,workspace_id,bytes,capability_until,cleanup_requested,released_at)
  SELECT NEW.id,c.workspace_id,NEW.declared_size_bytes,NEW.upload_expires_at,NEW.status IN ('deleting','rejected','deleted'),
    CASE WHEN NEW.deleted_at IS NOT NULL THEN NEW.deleted_at END
  FROM conversations c WHERE c.id=NEW.conversation_id AND c.workspace_id IS NOT NULL
  ON CONFLICT(attachment_id) DO UPDATE SET capability_until=EXCLUDED.capability_until,
    cleanup_requested=EXCLUDED.cleanup_requested,released_at=EXCLUDED.released_at;
  RETURN NEW;
END $$;
CREATE TRIGGER attachments_account_charge AFTER INSERT OR UPDATE ON attachments FOR EACH ROW EXECUTE FUNCTION account_attachment_charge();
--> statement-breakpoint
-- Durable cleanup has deliberately NO foreign key to canonical rows.
CREATE TABLE attachment_object_cleanup (
  attachment_id uuid NOT NULL,
  object_key text NOT NULL,
  version_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  requested boolean NOT NULL DEFAULT true,
  PRIMARY KEY (attachment_id, object_key, version_id)
);
CREATE INDEX attachment_object_cleanup_pending_idx ON attachment_object_cleanup(created_at) WHERE completed_at IS NULL;
--> statement-breakpoint
CREATE FUNCTION persist_attachment_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status='deleting' THEN
    UPDATE workspace_work SET state='cancelled',lease_token=NULL,lease_until=NULL,updated_at=now()
    WHERE kind='validation' AND idempotency_key=OLD.id::text AND state IN ('pending','running')
      AND workspace_id=(SELECT workspace_id FROM conversations WHERE id=OLD.conversation_id);
  END IF;
  IF TG_OP = 'DELETE' OR NEW.status IN ('deleting','rejected') THEN
    UPDATE workspace_attachment_charges SET cleanup_requested=true WHERE attachment_id=OLD.id;
    IF OLD.clean_key IS NOT NULL AND OLD.clean_version_id IS NOT NULL THEN
      INSERT INTO attachment_object_cleanup(attachment_id,object_key,version_id)
      VALUES(OLD.id,OLD.clean_key,OLD.clean_version_id) ON CONFLICT(attachment_id,object_key,version_id) DO UPDATE SET requested=true;
    END IF;
    IF OLD.quarantine_version_id IS NOT NULL THEN
      INSERT INTO attachment_object_cleanup(attachment_id,object_key,version_id)
      VALUES(OLD.id,OLD.quarantine_key,OLD.quarantine_version_id) ON CONFLICT(attachment_id,object_key,version_id) DO UPDATE SET requested=true;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER attachments_cleanup_before_delete BEFORE DELETE ON attachments FOR EACH ROW EXECUTE FUNCTION persist_attachment_cleanup();
CREATE TRIGGER attachments_cleanup_before_update BEFORE UPDATE ON attachments FOR EACH ROW EXECUTE FUNCTION persist_attachment_cleanup();

--> statement-breakpoint
-- Only maintenance authority may acknowledge/release cleanup receipts/charges.
CREATE FUNCTION thechat_worker_only() RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT false $$;
ALTER TABLE workspace_resource_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_work ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_attachment_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachment_object_cleanup ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_access ON workspace_resource_limits USING (thechat_can_workspace(workspace_id)) WITH CHECK (thechat_can_workspace(workspace_id));
CREATE POLICY tenant_access ON workspace_work USING (thechat_can_workspace(workspace_id)) WITH CHECK (thechat_can_workspace(workspace_id));
CREATE POLICY tenant_read ON workspace_attachment_charges FOR SELECT USING (thechat_can_workspace(workspace_id));
CREATE POLICY tenant_access ON attachment_object_cleanup USING (thechat_worker_only()) WITH CHECK (thechat_worker_only());
-- Trigger authority accepts no caller-controlled coordinates: only OLD/NEW
-- attachment rows admitted through conversation RLS; no callable SQL RPC.
ALTER FUNCTION account_attachment_charge() SECURITY DEFINER;
ALTER FUNCTION account_attachment_charge() SET search_path=pg_catalog,public;
ALTER FUNCTION account_attachment_charge() SET row_security=off;
ALTER FUNCTION persist_attachment_cleanup() SECURITY DEFINER;
ALTER FUNCTION persist_attachment_cleanup() SET search_path=pg_catalog,public;
ALTER FUNCTION persist_attachment_cleanup() SET row_security=off;
REVOKE ALL ON FUNCTION account_attachment_charge(),persist_attachment_cleanup() FROM PUBLIC;

--> statement-breakpoint
-- Attachment partitions have resource ownership even without an envelope tenant.
-- Resolve that ownership, never permit unknown/system partitions to actors.
CREATE OR REPLACE FUNCTION thechat_can_event(tenant text, partition text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
 SELECT CASE
 WHEN partition ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN public.thechat_can_conversation(partition::uuid)
 WHEN partition ~ '^attachment:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN EXISTS (
  SELECT 1 FROM public.attachments a WHERE a.id=substring(partition from 12)::uuid AND public.thechat_can_conversation(a.conversation_id))
 ELSE public.thechat_can_workspace(tenant) END
$$;

--> statement-breakpoint
-- Canonical terminal/cascade paths cannot strand or resurrect workspace work.
CREATE FUNCTION settle_bot_invocation_work() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE terminal boolean; cancelled boolean;
BEGIN
 IF TG_OP='DELETE' THEN terminal=true;cancelled=true;
 ELSE terminal=NEW.status IN ('completed','failed','cancelled') OR NEW.response_json->'completion' IS NOT NULL;
  cancelled=NEW.status IN ('failed','cancelled') OR NEW.response_json->'completion'->>'type' IN ('failed','cancelled'); END IF;
 IF terminal THEN UPDATE public.workspace_work SET state=CASE WHEN cancelled THEN 'cancelled' ELSE 'completed' END,lease_token=NULL,lease_until=NULL,updated_at=now()
  WHERE kind='bot' AND idempotency_key=OLD.id::text AND state IN ('pending','running'); END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bot_invocations_settle_work BEFORE UPDATE OR DELETE ON bot_invocations FOR EACH ROW EXECUTE FUNCTION settle_bot_invocation_work();
REVOKE ALL ON FUNCTION settle_bot_invocation_work() FROM PUBLIC;
--> statement-breakpoint
-- Old admitted work has no fenced epoch. Preserve its history, but never replay
-- uncertain external executions into the new budget/installation generation.
-- Operators must quiesce old writers/workers and review these IDs before cutover.
-- A recorded legacy silent completion is terminal, not uncertain execution.
-- Normalize only its status; preserve the response and recorded completion time.
UPDATE bot_invocations SET status='completed',updated_at=now()
 WHERE status IN ('queued','running','claimed') AND response_json->'completion' IS NULL AND response_json->>'silent'='true';
UPDATE bot_invocations
 SET status='cancelled',completed_at=now(),updated_at=now(),
 error=concat_ws('; ',nullif(error,''),'Tenant lifecycle cutover cancelled legacy work; external execution must not be replayed')
 WHERE status IN ('queued','running','claimed') AND response_json->'completion' IS NULL;

--> statement-breakpoint
-- Owner withdrawal is not workspace administration or content visibility.
CREATE FUNCTION thechat_lock_owned_bot_removal(target_bot uuid, target_workspace text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE bot_user uuid;
BEGIN
 IF NOT public.thechat_has_actor() OR NOT public.thechat_scope_allows(target_workspace) THEN RAISE EXCEPTION 'Bot withdrawal denied' USING ERRCODE='42501'; END IF;
 SELECT b.user_id INTO bot_user FROM public.bots b JOIN public.users u ON u.id=b.owner_id
 WHERE b.id=target_bot AND b.owner_id=public.thechat_actor() AND u.type='human';
 IF NOT FOUND THEN RAISE EXCEPTION 'Bot withdrawal denied' USING ERRCODE='42501'; END IF;
 -- Return the same empty result for an absent installation and an unknown
 -- workspace; global ownership must not become a workspace-existence oracle.
 IF NOT EXISTS(SELECT 1 FROM public.workspace_members WHERE workspace_id=target_workspace AND user_id=bot_user)
  AND NOT EXISTS(SELECT 1 FROM public.bot_workspace_installations WHERE workspace_id=target_workspace AND bot_id=target_bot) THEN RETURN false; END IF;
 PERFORM 1 FROM public.workspaces WHERE id=target_workspace FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM 1 FROM public.bots WHERE id=target_bot AND owner_id=public.thechat_actor() FOR KEY SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Bot withdrawal denied' USING ERRCODE='42501'; END IF;
 RETURN EXISTS(SELECT 1 FROM public.workspace_members WHERE workspace_id=target_workspace AND user_id=bot_user)
  OR EXISTS(SELECT 1 FROM public.bot_workspace_installations WHERE workspace_id=target_workspace AND bot_id=target_bot);
END $$;
CREATE FUNCTION thechat_withdraw_owned_bot(target_bot uuid, target_workspace text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET row_security=off AS $$
DECLARE bot_user uuid; removed integer; event_id uuid; targets jsonb; envelope jsonb;
BEGIN
 IF NOT public.thechat_lock_owned_bot_removal(target_bot,target_workspace) THEN RETURN false; END IF;
 SELECT user_id INTO bot_user FROM public.bots WHERE id=target_bot AND owner_id=public.thechat_actor();
 UPDATE public.bot_invocations i SET status='cancelled',error='Bot removed from workspace',completed_at=now(),updated_at=now()
 FROM public.conversations c WHERE i.conversation_id=c.id AND c.workspace_id=target_workspace AND i.bot_id=target_bot
 AND (i.status IN ('queued','running') OR i.status='claimed' AND nullif(i.response_json->'completion'->>'type','') IS NULL AND coalesce(i.response_json->>'silent','false')<>'true');
 WITH revoked AS (
  SELECT pending.id,coalesce((SELECT jsonb_agg(target.value) FROM jsonb_array_elements(pending.event->'payload'->'targetBotIds') AS target(value)
   WHERE target.value<>to_jsonb(target_bot::text)),'[]'::jsonb) AS remaining_targets
  FROM public.event_outbox pending WHERE pending.event_type='chat.message.sent' AND pending.published_at IS NULL AND pending.dead_at IS NULL
   AND pending.event->'tenant'->>'workspaceId'=target_workspace AND pending.event->'payload'->'targetBotIds' @> jsonb_build_array(target_bot::text)
 ) UPDATE public.event_outbox pending SET event=jsonb_set(pending.event,'{payload,targetBotIds}',revoked.remaining_targets),
  dead_at=CASE WHEN jsonb_array_length(revoked.remaining_targets)=0 THEN now() ELSE pending.dead_at END,
  last_error=CASE WHEN jsonb_array_length(revoked.remaining_targets)=0 THEN 'Target bot removed from workspace' ELSE pending.last_error END,
  locked_by=CASE WHEN jsonb_array_length(revoked.remaining_targets)=0 THEN NULL ELSE pending.locked_by END,
  locked_at=CASE WHEN jsonb_array_length(revoked.remaining_targets)=0 THEN NULL ELSE pending.locked_at END
 FROM revoked WHERE pending.id=revoked.id;
 DELETE FROM public.conversation_participants p USING public.conversations c WHERE p.conversation_id=c.id AND c.workspace_id=target_workspace AND p.user_id=bot_user;
 DELETE FROM public.bot_workspace_installations WHERE workspace_id=target_workspace AND bot_id=target_bot;
 DELETE FROM public.workspace_members WHERE workspace_id=target_workspace AND user_id=bot_user;
 GET DIAGNOSTICS removed=ROW_COUNT;
 IF removed>0 THEN
  SELECT coalesce(jsonb_agg(x.user_id),'[]'::jsonb) INTO targets FROM (
   SELECT m.user_id FROM public.workspace_members m JOIN public.users u ON u.id=m.user_id WHERE m.workspace_id=target_workspace AND u.type='human'
   UNION SELECT bot_user
  ) x;
  event_id=gen_random_uuid();
  envelope=jsonb_build_object('id',event_id,'type','workspace.lifecycle.notification','version',1,'aggregate',jsonb_build_object('type','workspace','id',target_workspace),
   'tenant',jsonb_build_object('workspaceId',target_workspace),'actor',jsonb_build_object('type','system','id','thechat'),'occurredAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
   'payload',jsonb_build_object('targetUserIds',targets,'event',jsonb_build_object('type','member_removed','workspaceId',target_workspace,'userId',bot_user)));
  INSERT INTO public.event_outbox(id,event_type,event_version,aggregate_type,aggregate_id,tenant_id,actor_type,actor_id,partition_key,event)
   VALUES(event_id,'workspace.lifecycle.notification',1,'workspace',target_workspace,target_workspace,'system','thechat','workspace-lifecycle:'||target_workspace,envelope);
 END IF;
 RETURN removed>0;
END $$;
REVOKE ALL ON FUNCTION thechat_lock_owned_bot_removal(uuid,text),thechat_withdraw_owned_bot(uuid,text) FROM PUBLIC;

--> statement-breakpoint
DO $$ DECLARE fn regprocedure; BEGIN
 FOR fn IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'thechat_%'
 LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn); END LOOP;
END $$;
