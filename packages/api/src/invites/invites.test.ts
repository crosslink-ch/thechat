import { describe, test, expect, afterAll } from "bun:test";
import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { db } from "../db";
import {
  users,
  workspaces,
  workspaceMembers,
  workspaceInvites,
  conversationParticipants,
  conversations,
} from "../db/schema";
import { authRoutes } from "../auth";
import { workspaceRoutes } from "../workspaces";
import { inviteRoutes } from "./index";
import crypto from "crypto";

const app = new Elysia().use(authRoutes).use(workspaceRoutes).use(inviteRoutes);

function uniqueEmail() {
  return `test-${crypto.randomUUID()}@test.com`;
}

const createdUserEmails: string[] = [];
const createdWorkspaceIds: string[] = [];

async function cleanup() {
  for (const id of createdWorkspaceIds) {
    await db.delete(workspaces).where(eq(workspaces.id, id));
  }
  for (const email of createdUserEmails) {
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (user) {
      await db.delete(users).where(eq(users.id, user.id));
    }
  }
}

afterAll(cleanup);

async function req(
  method: string,
  path: string,
  body?: unknown,
  token?: string
) {
  const headers: Record<string, string> = {};
  if (body) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })
  );

  const text = await response.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, body: json };
}

async function registerAndGetToken(name = "Test User"): Promise<{
  token: string;
  user: { id: string; name: string; email: string };
}> {
  const email = uniqueEmail();
  createdUserEmails.push(email);

  const res = await req("POST", "/auth/register", {
    name,
    email,
    password: "password123",
  });

  return { token: res.body.accessToken, user: res.body.user };
}

async function createTestWorkspace(token: string, name = "Test Workspace") {
  const res = await req("POST", "/workspaces/create", { name }, token);
  createdWorkspaceIds.push(res.body.id);
  return res.body;
}

describe("Invites: Create", () => {
  test("owner can invite by email", async () => {
    const owner = await registerAndGetToken("Owner");
    const invitee = await registerAndGetToken("Invitee");
    const ws = await createTestWorkspace(owner.token, "Invite Test");

    const res = await req(
      "POST",
      "/invites/create",
      { workspaceId: ws.id, email: invitee.user.email },
      owner.token
    );

    expect(res.status).toBe(200);
    expect(res.body.id).toBeDefined();
    expect(res.body.workspaceId).toBe(ws.id);
    expect(res.body.workspaceName).toBe("Invite Test");
    expect(res.body.inviterId).toBe(owner.user.id);
    expect(res.body.inviterName).toBe("Owner");
    expect(res.body.createdAt).toBeDefined();
  });

  test("admin can invite", async () => {
    const owner = await registerAndGetToken("Owner");
    const admin = await registerAndGetToken("Admin");
    const invitee = await registerAndGetToken("Invitee");
    const ws = await createTestWorkspace(owner.token, "Admin Invite");

    // Make admin a member via invite flow first, then promote to admin
    const invRes = await req(
      "POST",
      "/invites/create",
      { workspaceId: ws.id, email: admin.user.email },
      owner.token
    );
    await req("POST", "/invites/accept", { inviteId: invRes.body.id }, admin.token);

    // Promote to admin directly in DB
    await db
      .update(workspaceMembers)
      .set({ role: "admin" })
      .where(
        eq(workspaceMembers.userId, admin.user.id)
      );

    const res = await req(
      "POST",
      "/invites/create",
      { workspaceId: ws.id, email: invitee.user.email },
      admin.token
    );

    expect(res.status).toBe(200);
  });

  test("regular member cannot invite", async () => {
    const owner = await registerAndGetToken("Owner");
    const member = await registerAndGetToken("Member");
    const invitee = await registerAndGetToken("Invitee");
    const ws = await createTestWorkspace(owner.token, "Member No Invite");

    // Add member via invite
    const invRes = await req(
      "POST",
      "/invites/create",
      { workspaceId: ws.id, email: member.user.email },
      owner.token
    );
    await req("POST", "/invites/accept", { inviteId: invRes.body.id }, member.token);

    const res = await req(
      "POST",
      "/invites/create",
      { workspaceId: ws.id, email: invitee.user.email },
      member.token
    );

    expect(res.status).toBe(403);
  });

  test("invite non-existent email returns 404", async () => {
    const owner = await registerAndGetToken("Owner");
    const ws = await createTestWorkspace(owner.token, "No User");

    const res = await req(
      "POST",
      "/invites/create",
      { workspaceId: ws.id, email: "nonexistent@example.com" },
      owner.token
    );

    expect(res.status).toBe(404);
  });

  test("invite existing member returns 409", async () => {
    const owner = await registerAndGetToken("Owner");
    const ws = await createTestWorkspace(owner.token, "Already Member");

    // Owner is already a member
    const res = await req(
      "POST",
      "/invites/create",
      { workspaceId: ws.id, email: owner.user.email },
      owner.token
    );

    expect(res.status).toBe(409);
  });

  test("duplicate pending invite returns 409", async () => {
    const owner = await registerAndGetToken("Owner");
    const invitee = await registerAndGetToken("Invitee");
    const ws = await createTestWorkspace(owner.token, "Dup Invite");

    await req(
      "POST",
      "/invites/create",
      { workspaceId: ws.id, email: invitee.user.email },
      owner.token
    );

    const res = await req(
      "POST",
      "/invites/create",
      { workspaceId: ws.id, email: invitee.user.email },
      owner.token
    );

    expect(res.status).toBe(409);
  });
});

describe("Invites: Accept", () => {
  test("accept invite makes user a member", async () => {
    const owner = await registerAndGetToken("Owner");
    const invitee = await registerAndGetToken("Invitee");
    const ws = await createTestWorkspace(owner.token, "Accept Test");

    const invRes = await req(
      "POST",
      "/invites/create",
      { workspaceId: ws.id, email: invitee.user.email },
      owner.token
    );

    const acceptRes = await req(
      "POST",
      "/invites/accept",
      { inviteId: invRes.body.id },
      invitee.token
    );

    expect(acceptRes.status).toBe(200);
    expect(acceptRes.body.success).toBe(true);
    expect(acceptRes.body.workspaceId).toBe(ws.id);

    // Verify membership
    const detailRes = await req(
      "GET",
      `/workspaces/${ws.id}`,
      undefined,
      invitee.token
    );

    expect(detailRes.status).toBe(200);
    expect(detailRes.body.members).toHaveLength(2);
  });

  test("accepted user is enrolled in channels", async () => {
    const owner = await registerAndGetToken("Owner");
    const invitee = await registerAndGetToken("Invitee");
    const ws = await createTestWorkspace(owner.token, "Channel Enroll");

    const invRes = await req(
      "POST",
      "/invites/create",
      { workspaceId: ws.id, email: invitee.user.email },
      owner.token
    );

    await req(
      "POST",
      "/invites/accept",
      { inviteId: invRes.body.id },
      invitee.token
    );

    // Get workspace channels
    const detailRes = await req(
      "GET",
      `/workspaces/${ws.id}`,
      undefined,
      invitee.token
    );

    const channelId = detailRes.body.channels[0].id;
    const participants = await db
      .select()
      .from(conversationParticipants)
      .where(eq(conversationParticipants.conversationId, channelId));

    const inviteeParticipant = participants.find(
      (p) => p.userId === invitee.user.id
    );
    expect(inviteeParticipant).toBeDefined();
  });

  test("cannot accept another user's invite", async () => {
    const owner = await registerAndGetToken("Owner");
    const invitee = await registerAndGetToken("Invitee");
    const stranger = await registerAndGetToken("Stranger");
    const ws = await createTestWorkspace(owner.token, "Wrong User");

    const invRes = await req(
      "POST",
      "/invites/create",
      { workspaceId: ws.id, email: invitee.user.email },
      owner.token
    );

    const res = await req(
      "POST",
      "/invites/accept",
      { inviteId: invRes.body.id },
      stranger.token
    );

    expect(res.status).toBe(403);
  });

  test("cannot accept already-accepted invite", async () => {
    const owner = await registerAndGetToken("Owner");
    const invitee = await registerAndGetToken("Invitee");
    const ws = await createTestWorkspace(owner.token, "Double Accept");

    const invRes = await req(
      "POST",
      "/invites/create",
      { workspaceId: ws.id, email: invitee.user.email },
      owner.token
    );

    await req(
      "POST",
      "/invites/accept",
      { inviteId: invRes.body.id },
      invitee.token
    );

    const res = await req(
      "POST",
      "/invites/accept",
      { inviteId: invRes.body.id },
      invitee.token
    );

    expect(res.status).toBe(400);
  });
});

describe("Invites: Decline", () => {
  test("decline invite updates status", async () => {
    const owner = await registerAndGetToken("Owner");
    const invitee = await registerAndGetToken("Invitee");
    const ws = await createTestWorkspace(owner.token, "Decline Test");

    const invRes = await req(
      "POST",
      "/invites/create",
      { workspaceId: ws.id, email: invitee.user.email },
      owner.token
    );

    const declineRes = await req(
      "POST",
      "/invites/decline",
      { inviteId: invRes.body.id },
      invitee.token
    );

    expect(declineRes.status).toBe(200);
    expect(declineRes.body.success).toBe(true);

    // User should NOT be a member
    const detailRes = await req(
      "GET",
      `/workspaces/${ws.id}`,
      undefined,
      invitee.token
    );

    expect(detailRes.status).toBe(403);
  });
});

describe("Invites: List Pending", () => {
  test("returns only pending invites for requesting user", async () => {
    const owner = await registerAndGetToken("Owner");
    const invitee = await registerAndGetToken("Invitee");
    const other = await registerAndGetToken("Other");
    const ws1 = await createTestWorkspace(owner.token, "Pending One");
    const ws2 = await createTestWorkspace(owner.token, "Pending Two");

    // Create invite for invitee to ws1
    await req(
      "POST",
      "/invites/create",
      { workspaceId: ws1.id, email: invitee.user.email },
      owner.token
    );

    // Create invite for invitee to ws2
    await req(
      "POST",
      "/invites/create",
      { workspaceId: ws2.id, email: invitee.user.email },
      owner.token
    );

    // Create invite for other to ws1 (should NOT show up for invitee)
    await req(
      "POST",
      "/invites/create",
      { workspaceId: ws1.id, email: other.user.email },
      owner.token
    );

    const res = await req(
      "GET",
      "/invites/pending",
      undefined,
      invitee.token
    );

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);

    const wsIds = res.body.map((inv: any) => inv.workspaceId);
    expect(wsIds).toContain(ws1.id);
    expect(wsIds).toContain(ws2.id);

    // Other user should only see their own
    const otherRes = await req(
      "GET",
      "/invites/pending",
      undefined,
      other.token
    );

    expect(otherRes.body).toHaveLength(1);
    expect(otherRes.body[0].workspaceId).toBe(ws1.id);
  });
});
