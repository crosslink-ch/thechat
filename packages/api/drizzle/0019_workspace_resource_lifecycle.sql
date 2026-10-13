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
