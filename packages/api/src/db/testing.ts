import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

// Explicit fixture/repair authority is never used by a request or a service.
// Integration tests keep their setup/cleanup authority separate from the real
// restricted-role path under test. No fallback to the application URL.
export function createFixtureDatabase(url: string | undefined) {
if (!url) throw new Error('DATABASE_MIGRATION_URL is required for disposable test fixtures');
const parsed=new URL(url);
if (process.env.NODE_ENV==='production' || !['127.0.0.1','localhost','::1'].includes(parsed.hostname) || !parsed.pathname.endsWith('_e2e')) {
  throw new Error('Test fixture database must be explicit loopback and disposable *_e2e');
}
return drizzle({client:postgres(url),schema});
}
export const db=createFixtureDatabase(process.env.DATABASE_MIGRATION_URL);
export { withDatabaseContext, withWorkerDatabaseContext } from './context';
