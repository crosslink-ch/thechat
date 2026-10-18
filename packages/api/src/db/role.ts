import { sql } from "drizzle-orm";
import type { DatabaseExecutor } from "./context";
import { collaborationPolicyDefinitions } from './policies';

export const protectedCollaborationTables = Object.keys(collaborationPolicyDefinitions);

export async function verifyWorkerDatabase(database: Pick<DatabaseExecutor,'execute'>) {
  const [role]=await database.execute<{unsafe: boolean}>(sql`
    SELECT NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) OR EXISTS (
      SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user,r.oid,'MEMBER') AND (
        r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolbypassrls AND r.rolname<>current_user
        OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relowner=r.oid)
      )
    ) OR has_schema_privilege(current_user,'public','CREATE') AS unsafe
  `);
  if (!role || role.unsafe) throw new Error('Unsafe worker database role: requires separate non-owner BYPASSRLS maintenance authority');
}

export async function verifyAuthenticationDatabase(database: Pick<DatabaseExecutor,'execute'>) {
  const [role]=await database.execute<{unsafe: boolean}>(sql`
    SELECT NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname='thechat_identity_authority' AND pg_has_role(current_user,r.oid,'MEMBER')) OR EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user,r.oid,'MEMBER') AND (
      r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb
      OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relowner=r.oid)
    )) OR has_schema_privilege(current_user,'public','CREATE') OR EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'
      AND (c.relname IN ('workspaces','event_outbox') OR EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND NOT a.attisdropped AND a.attname IN ('workspace_id','conversation_id','message_id')))
      AND has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
    ) AS unsafe
  `);
  if (!role || role.unsafe) throw new Error('Unsafe authentication database role: privileged or has collaboration grants');
}

/** Refuse owner/BYPASSRLS/set-role paths and missing/extra permissive policies. */
export async function verifyRuntimeDatabase(database: Pick<DatabaseExecutor, 'execute'>) {
  const [role] = await database.execute<{ unsafe: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user,r.oid,'MEMBER') AND (
        r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolname='thechat_identity_authority'
        OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relowner=r.oid AND n.nspname='public')
        OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.proowner=r.oid AND n.nspname='public' AND p.proname LIKE 'thechat_%')
      )
    ) OR has_schema_privilege(current_user,'public','CREATE')
      OR has_column_privilege(current_user,'public.apikey','key','SELECT')
      OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND has_table_privilege(current_user,c.oid,'TRUNCATE,TRIGGER')) AS unsafe
  `);
  if (!role || role.unsafe) throw new Error('Unsafe application database role: owner, bypass, DDL or privileged membership');
  // New installations, budgets and cleanup tables cannot quietly evade RLS:
  // every public table carrying a tenant/resource key is included automatically.
  const tables = await database.execute<{ name: string; enabled: boolean; policies: number; unsafePolicies: number }>(sql`
    SELECT c.relname AS name,c.relrowsecurity AS enabled,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid=c.oid) AS policies,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid=c.oid AND (
        p.polname NOT IN ('tenant_access','tenant_read','tenant_insert','tenant_update','tenant_delete')
        OR (p.polqual IS NOT NULL AND pg_get_expr(p.polqual,p.polrelid) NOT LIKE '%thechat_%')
        OR (p.polwithcheck IS NOT NULL AND pg_get_expr(p.polwithcheck,p.polrelid) NOT LIKE '%thechat_%')
      )) AS "unsafePolicies"
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND (
      c.relname IN (${sql.join(protectedCollaborationTables.map(name => sql`${name}`), sql`,`)})
      OR EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND NOT a.attisdropped AND a.attname IN ('workspace_id','conversation_id','message_id'))
    )
  `);
  for (const table of protectedCollaborationTables) {
    if (!tables.some(row => row.name === table)) throw new Error(`Missing protected database table: ${table}`);
  }
  for (const table of tables) {
    if (!Object.hasOwn(collaborationPolicyDefinitions, table.name)) {
      throw new Error(`Unregistered protected database table: ${table.name}`);
    }
    if (!table.enabled || table.policies === 0 || table.unsafePolicies > 0) {
      throw new Error(`Unsafe collaboration RLS policy configuration: ${table.name}`);
    }
  }
  const policies = await database.execute<{ table: string; name: string; command: string; using: string | null; withCheck: string | null; roles: string[] }>(sql`
    SELECT tablename AS "table",policyname AS name,lower(cmd) AS command,qual AS "using",with_check AS "withCheck",roles::text[] AS roles
    FROM pg_policies WHERE schemaname='public'
  `);
  for (const [table, expected] of Object.entries(collaborationPolicyDefinitions)) {
    const actual = policies.filter(policy => policy.table === table);
    if (actual.length !== expected.length || expected.some(policy => !actual.some(row => row.name === policy.name && row.command === policy.command && row.using === policy.using && row.withCheck === policy.withCheck && row.roles.length === 1 && row.roles[0] === 'public'))) {
      throw new Error(`Unsafe collaboration RLS policy configuration: ${table}`);
    }
  }
}
