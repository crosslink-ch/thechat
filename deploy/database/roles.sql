-- Run as the database/role administrator AFTER migrations, never as API.
-- Required psql -v variables: runtime_role, auth_role, worker_role, migration_role.
-- No passwords are accepted/rendered here. New roles are NOLOGIN until the
-- operator provisions a distinct credential using the secret manager.
\set ON_ERROR_STOP on
-- A non-privileged marker separates global credential/identity administration
-- from runtime DML. Runtime MUST NOT inherit/be able to SET ROLE to this marker.
SELECT 'CREATE ROLE thechat_identity_authority NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='thechat_identity_authority') \gexec
SELECT 1 / CASE WHEN :'runtime_role'<>:'auth_role' AND :'runtime_role'<>:'worker_role' AND :'runtime_role'<>:'migration_role' AND :'auth_role'<>:'worker_role' AND :'auth_role'<>:'migration_role' AND :'worker_role'<>:'migration_role' THEN 1 ELSE 0 END AS distinct_authorities;
SELECT format('CREATE ROLE %I NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE', :'runtime_role') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=:'runtime_role') \gexec
SELECT format('CREATE ROLE %I NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE', :'auth_role') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=:'auth_role') \gexec
SELECT format('CREATE ROLE %I NOLOGIN NOINHERIT NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE', :'worker_role') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=:'worker_role') \gexec
ALTER ROLE :"runtime_role" NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
ALTER ROLE :"auth_role" NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
ALTER ROLE :"worker_role" NOINHERIT NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM :"runtime_role", :"auth_role", :"worker_role";
GRANT USAGE ON SCHEMA public TO :"runtime_role", :"auth_role", :"worker_role";
-- Discovery automatically includes new installation/budget/cleanup tables,
-- but the startup gate refuses any discovered table lacking canonical RLS.
SELECT format('GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.%I TO %I,%I',c.relname,:'runtime_role',:'worker_role')
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind='r' AND (
  c.relname IN ('workspaces','event_outbox') OR EXISTS (
    SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND NOT a.attisdropped AND a.attname IN ('workspace_id','conversation_id','message_id')
  )
) \gexec
-- Global identity/bot administration remains a service-level ownership plane.
GRANT SELECT,INSERT,UPDATE,DELETE ON users,bots,hermes_bot_configs TO :"runtime_role";
GRANT SELECT ON users,bots,hermes_bot_configs TO :"worker_role";
-- Endpoint row locks use the narrow SECURITY DEFINER RPC. Remove the obsolete
-- column grant too when upgrading an earlier candidate's role recipe.
REVOKE UPDATE(endpoint_revision) ON bots FROM :"worker_role";
GRANT SELECT,INSERT,UPDATE,DELETE ON users,session,account,verification,apikey,rate_limit TO :"auth_role";
GRANT SELECT ON bots TO :"auth_role";
GRANT SELECT ON bot_invite_metadata TO :"runtime_role";
GRANT SELECT ON bot_runtime_metadata TO :"runtime_role", :"worker_role";
GRANT SELECT ON bot_identities TO :"runtime_role", :"auth_role", :"worker_role";
GRANT thechat_identity_authority TO :"auth_role";
-- No authority depends on PUBLIC function execution. Runtime gets the named,
-- actor-gated application RPC surface; auth/worker get only their required
-- helpers. In particular maintenance cannot call global endpoint/command or
-- owner-consent/withdrawal mutations by manufacturing an actor GUC.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM :"runtime_role", :"auth_role", :"worker_role";
SELECT format('GRANT EXECUTE ON FUNCTION %s TO %I',p.oid::regprocedure,:'runtime_role')
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname LIKE 'thechat_%' AND p.prorettype<>'trigger'::regtype \gexec
SELECT format('GRANT EXECUTE ON FUNCTION %s TO %I',p.oid::regprocedure,:'auth_role')
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname IN ('thechat_actor','thechat_has_actor','thechat_scope_allows','thechat_identity_authority','thechat_owns_bot_user','thechat_claim_bot_user') \gexec
SELECT format('GRANT EXECUTE ON FUNCTION %s TO %I',p.oid::regprocedure,:'worker_role')
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname IN (
 'thechat_actor','thechat_has_actor','thechat_scope_allows','thechat_identity_authority','thechat_owns_bot_user',
 'thechat_can_workspace','thechat_can_conversation','thechat_manage_workspace','thechat_manage_bot',
 'thechat_bootstrap_workspace','thechat_bootstrap_conversation','thechat_invited_workspace','thechat_can_enroll',
 'thechat_can_event','thechat_read_bot','thechat_installation_owner','thechat_worker_only',
 'thechat_lock_bot_endpoint','thechat_sign_invocation'
) \gexec
-- Bot identity and first credential commit atomically in the actor transaction.
-- Credential values are not readable/mutable by collaboration runtime SQL.
GRANT INSERT ON apikey TO :"runtime_role";
GRANT SELECT(reference_id,enabled,config_id) ON apikey TO :"runtime_role";
-- Ledger release and exact storage receipts are worker-only. API may read usage
-- for its own tenant; trigger SECURITY DEFINER writes originate from admitted rows.
REVOKE INSERT,UPDATE,DELETE ON workspace_attachment_charges FROM :"runtime_role";
GRANT SELECT,INSERT,UPDATE,DELETE ON attachment_object_cleanup TO :"worker_role";
-- No membership grants between these roles; no TRUNCATE/TRIGGER/DDL grants.
-- The migrator must own the tables/functions (or have administrator authority),
-- and must never be inherited/SET ROLE-able by runtime/auth/worker identities.
