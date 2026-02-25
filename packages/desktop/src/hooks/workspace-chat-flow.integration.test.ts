/**
 * Integration test: full workspace chat flow between two users.
 *
 * Steps tested:
 *  1. Register User A and User B
 *  2. User A creates a workspace
 *  3. User A invites User B to the workspace
 *  4. User B accepts the invitation
 *  5. User A opens the "general" channel
 *  6. User B opens the "general" channel
 *  7. User A sends a message
 *  8. User B can see the message
 *
 * Requires:
 *  - API server running on port 3000 (with PostgreSQL)
 *
 * Run:
 *   pnpm test:integration
 *   # or:
 *   INTEGRATION=true pnpm test:desktop -- src/hooks/workspace-chat-flow.integration.test.ts
 */
import { describe, test, expect, afterAll } from "vitest";
import { treaty } from "@elysiajs/eden";
import type { App } from "@thechat/api";

const INTEGRATION = process.env.INTEGRATION === "true";

const API_URL = "http://localhost:3000";

const api = treaty<App>(API_URL);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function auth(token: string) {
  return { headers: { authorization: `Bearer ${token}` } };
}

let emailCounter = 0;
function uniqueEmail() {
  return `flow-${Date.now()}-${++emailCounter}@test.com`;
}

const createdEmails: string[] = [];
let createdWorkspaceId: string | undefined;

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterAll(async () => {
  if (!INTEGRATION) return;
  const { cleanupWorkspace, cleanupUserByEmail } = await import(
    "@thechat/api/test-helpers"
  );

  if (createdWorkspaceId) {
    await cleanupWorkspace(createdWorkspaceId);
  }
  for (const email of createdEmails) {
    await cleanupUserByEmail(email);
  }
});

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe.skipIf(!INTEGRATION)(
  "Workspace chat flow: invite, join, message",
  () => {
    let userA: { token: string; user: { id: string; name: string; email: string | null } };
    let userB: { token: string; user: { id: string; name: string; email: string | null } };
    let workspaceId: string;
    let generalChannelId: string;

    test("1. Register User A and User B", async () => {
      const emailA = uniqueEmail();
      const emailB = uniqueEmail();
      createdEmails.push(emailA, emailB);

      const { data: dataA, error: errA } = await api.auth.register.post({
        name: "Alice",
        email: emailA,
        password: "password123",
      });
      expect(errA).toBeNull();
      expect(dataA!.accessToken).toBeTruthy();
      expect(dataA!.user!.name).toBe("Alice");
      userA = { token: dataA!.accessToken!, user: dataA!.user! };

      const { data: dataB, error: errB } = await api.auth.register.post({
        name: "Bob",
        email: emailB,
        password: "password123",
      });
      expect(errB).toBeNull();
      expect(dataB!.accessToken).toBeTruthy();
      expect(dataB!.user!.name).toBe("Bob");
      userB = { token: dataB!.accessToken!, user: dataB!.user! };
    });

    test("2. User A creates a workspace", async () => {
      const { data, error } = await api.workspaces.create.post(
        { name: "Flow Test Workspace" },
        auth(userA.token),
      );
      expect(error).toBeNull();
      expect((data as any).id).toBeTruthy();
      expect((data as any).name).toBe("Flow Test Workspace");

      workspaceId = (data as any).id;
      createdWorkspaceId = workspaceId;
    });

    test("3. User A invites User B to the workspace", async () => {
      const { data, error } = await api.invites.create.post(
        { workspaceId, email: userB.user.email! },
        auth(userA.token),
      );
      expect(error).toBeNull();
      expect((data as any).id).toBeTruthy();
      expect((data as any).workspaceId).toBe(workspaceId);
    });

    test("4. User B accepts the invitation", async () => {
      // User B should see the pending invite
      const { data: pending, error: pendingErr } =
        await api.invites.pending.get(auth(userB.token));
      expect(pendingErr).toBeNull();

      const invite = (pending as any[]).find(
        (i: any) => i.workspaceId === workspaceId,
      );
      expect(invite).toBeDefined();

      // Accept it
      const { data, error } = await api.invites.accept.post(
        { inviteId: invite.id },
        auth(userB.token),
      );
      expect(error).toBeNull();
      expect((data as any).success).toBe(true);

      // User B should now be a member of the workspace
      const { data: workspaces } = await api.workspaces.list.get(
        auth(userB.token),
      );
      const membership = (workspaces as any[]).find(
        (w: any) => w.id === workspaceId,
      );
      expect(membership).toBeDefined();
    });

    test("5. User A opens the 'general' channel", async () => {
      const { data, error } = await api.workspaces({ id: workspaceId }).get(
        auth(userA.token),
      );
      expect(error).toBeNull();

      const channels = (data as any).channels as any[];
      const general = channels.find((c) => c.name === "general");
      expect(general).toBeDefined();

      generalChannelId = general.id;
    });

    test("6. User B opens the 'general' channel", async () => {
      const { data, error } = await api.workspaces({ id: workspaceId }).get(
        auth(userB.token),
      );
      expect(error).toBeNull();

      const channels = (data as any).channels as any[];
      const general = channels.find((c) => c.name === "general");
      expect(general).toBeDefined();
      // Same channel ID for both users
      expect(general.id).toBe(generalChannelId);
    });

    test("7. User A sends a message", async () => {
      const { data, error } = await api
        .messages({ conversationId: generalChannelId })
        .post({ content: "Hello from Alice!" }, auth(userA.token));
      expect(error).toBeNull();
      expect((data as any).content).toBe("Hello from Alice!");
      expect((data as any).senderName).toBe("Alice");
    });

    test("8. User B can see the message", async () => {
      const { data, error } = await api
        .messages({ conversationId: generalChannelId })
        .get(auth(userB.token));
      expect(error).toBeNull();

      const messages = data as any[];
      const aliceMsg = messages.find(
        (m) => m.content === "Hello from Alice!",
      );
      expect(aliceMsg).toBeDefined();
      expect(aliceMsg.senderName).toBe("Alice");
    });
  },
);
