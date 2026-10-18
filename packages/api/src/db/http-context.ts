import { Elysia } from "elysia";
import { withDatabaseContext } from "./context";

/** Elysia's request HOF preserves ALS across the complete composed lifecycle.
 * onBeforeHandle/enterWith does not: it can leak identities between requests.
 * The pinned Elysia dependency implements wrap for both handle() and Bun routes.
 */
export const databaseHttpContext = new Elysia({ name: "authenticated-database-context" })
  .wrap(((next: any) => async (request: Request) => {
    // Preflight has no credentials or application effects; the CORS plugin
    // validates its exact Origin and requested headers before auth hooks.
    if (request.method === 'OPTIONS') return next(request);
    const { browserRequestPolicyError } = await import('../auth/browser');
    const policyError = browserRequestPolicyError(request);
    if (policyError) return Response.json({ error: policyError }, { status: 403 });
    const { resolveRequestUser, AuthInfrastructureError, authServiceUnavailable } = await import('../auth/middleware');
    let user;
    try { user = await resolveRequestUser(Object.fromEntries(request.headers.entries())); }
    catch (error) {
      if (error instanceof AuthInfrastructureError) return Response.json(authServiceUnavailable, { status: 503 });
      throw error;
    }
    if (!user) return next(request);
    return withDatabaseContext({ actorId: user.id, scope: 'actor' }, async () => await next(request));
  }) as any);
