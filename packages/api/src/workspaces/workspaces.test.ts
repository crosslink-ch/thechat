import { describe, test, expect, afterAll } from "bun:test";
import { Elysia } from "elysia";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import {
  users,
  workspaces,
  workspaceMembers,
  conversations,
  conversationParticipants,
  workspaceInvites,
} from "../db/schema";
import { authRoutes } from "../auth";
import { workspaceRoutes } from "./index";
import { inviteRoutes } from "../invites";
import { joinWorkspace } from "../services/workspaces";
import crypto from "crypto";

const app = new Elysia().use(authRoutes).use(workspaceRoutes).use(inviteRoutes);

function uniqueEmail() {
  return `test-${crypto.randomUUID()}@test.com`;
}

const createdUserEmails: string[] = [];
const createdWorkspaceIds: string[] = [];

async function cleanup() {
  // Clean up workspaces (cascades to members, channels, participants, invites)
  for (const id of createdWorkspaceIds) {
    await db.delete(workspaces).where(eq(workspaces.id, id));
  }
  // Clean up users
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

describe("Workspaces: Creation", () => {
  test("creates workspace and returns slug-based ID", async () => {
    const { token } = await registerAndGetToken();

    const res = await req("POST", "/workspaces/create", { name: "My Team" }, token);
    createdWorkspaceIds.push(res.body.id);

    expect(res.status).toBe(200);
    expect(res.body.id).toMatch(/^my-team-\d{5}$/);
    expect(res.body.name).toBe("My Team");
    expect(res.body.createdAt).toBeDefined();
  });

  test("creator becomes owner member", async () => {
    const { token, user } = await registerAndGetToken();

    const createRes = await req(
      "POST",
      "/workspaces/create",
      { name: "Owner Test" },
      token
    );
    createdWorkspaceIds.push(createRes.body.id);

    const detailRes = await req(
      "GET",
      `/workspaces/${createRes.body.id}`,
      undefined,
      token
    );

    expect(detailRes.status).toBe(200);
    const ownerMember = detailRes.body.members.find(
      (m: any) => m.userId === user.id
    );
    expect(ownerMember).toBeDefined();
    expect(ownerMember.role).toBe("owner");
  });

  test("General channel is auto-created", async () => {
    const { token } = await registerAndGetToken();

    const createRes = await req(
      "POST",
      "/workspaces/create",
      { name: "Channel Test" },
      token
    );
    createdWorkspaceIds.push(createRes.body.id);

    const detailRes = await req(
      "GET",
      `/workspaces/${createRes.body.id}`,
      undefined,
      token
    );

    expect(detailRes.body.channels).toHaveLength(1);
    expect(detailRes.body.channels[0].name).toBe("general");
    expect(detailRes.body.channels[0].title).toBe("General");
  });

  test("creator is participant of General channel", async () => {
    const { token, user } = await registerAndGetToken();

    const createRes = await req(
      "POST",
      "/workspaces/create",
      { name: "Participant Test" },
      token
    );
    createdWorkspaceIds.push(createRes.body.id);

    const detailRes = await req(
      "GET",
      `/workspaces/${createRes.body.id}`,
      undefined,
      token
    );

    const channelId = detailRes.body.channels[0].id;

    // Verify participant directly in DB
    const participants = await db
      .select()
      .from(conversationParticipants)
      .where(eq(conversationParticipants.conversationId, channelId));

    const creatorParticipant = participants.find(
      (p) => p.userId === user.id
    );
    expect(creatorParticipant).toBeDefined();
  });

  test("rejects empty name", async () => {
    const { token } = await registerAndGetToken();

    const res = await req("POST", "/workspaces/create", { name: "" }, token);
    expect(res.status).toBe(400);
  });

  test("rejects unauthenticated request", async () => {
    const res = await req("POST", "/workspaces/create", { name: "No Auth" });
    expect(res.status).toBe(401);
  });
});

describe("Workspaces: List", () => {
  test("lists all workspaces user belongs to", async () => {
    const { token } = await registerAndGetToken();

    const res1 = await req(
      "POST",
      "/workspaces/create",
      { name: "List One" },
      token
    );
    createdWorkspaceIds.push(res1.body.id);

    const res2 = await req(
      "POST",
      "/workspaces/create",
      { name: "List Two" },
      token
    );
    createdWorkspaceIds.push(res2.body.id);

    const listRes = await req("GET", "/workspaces/list", undefined, token);

    expect(listRes.status).toBe(200);
    expect(listRes.body.length).toBeGreaterThanOrEqual(2);

    const ids = listRes.body.map((w: any) => w.id);
    expect(ids).toContain(res1.body.id);
    expect(ids).toContain(res2.body.id);
  });

  test("returns empty list for user with no workspaces", async () => {
    const { token } = await registerAndGetToken();

    const listRes = await req("GET", "/workspaces/list", undefined, token);

    expect(listRes.status).toBe(200);
    expect(listRes.body).toEqual([]);
  });

  test("includes role via invite flow", async () => {
    const owner = await registerAndGetToken("Owner");
    const member = await registerAndGetToken("Member");

    const createRes = await req(
      "POST",
      "/workspaces/create",
      { name: "Role Check" },
      owner.token
    );
    createdWorkspaceIds.push(createRes.body.id);

    // Invite + accept flow
    const inviteRes = await req(
      "POST",
      "/invites/create",
      { workspaceId: createRes.body.id, email: member.user.email },
      owner.token
    );
    await req(
      "POST",
      "/invites/accept",
      { inviteId: inviteRes.body.id },
      member.token
    );

    const ownerList = await req("GET", "/workspaces/list", undefined, owner.token);
    const ownerWorkspace = ownerList.body.find(
      (w: any) => w.id === createRes.body.id
    );
    expect(ownerWorkspace.role).toBe("owner");

    const memberList = await req(
      "GET",
      "/workspaces/list",
      undefined,
      member.token
    );
    const memberWorkspace = memberList.body.find(
      (w: any) => w.id === createRes.body.id
    );
    expect(memberWorkspace.role).toBe("member");
  });
});

describe("Workspaces: Detail", () => {
  test("returns workspace with members and channels", async () => {
    const { token } = await registerAndGetToken();

    const createRes = await req(
      "POST",
      "/workspaces/create",
      { name: "Detail Test" },
      token
    );
    createdWorkspaceIds.push(createRes.body.id);

    const detailRes = await req(
      "GET",
      `/workspaces/${createRes.body.id}`,
      undefined,
      token
    );

    expect(detailRes.status).toBe(200);
    expect(detailRes.body.id).toBe(createRes.body.id);
    expect(detailRes.body.name).toBe("Detail Test");
    expect(detailRes.body.members).toBeInstanceOf(Array);
    expect(detailRes.body.members.length).toBeGreaterThanOrEqual(1);
    expect(detailRes.body.channels).toBeInstanceOf(Array);
    expect(detailRes.body.channels.length).toBeGreaterThanOrEqual(1);

    // Members have user info
    const member = detailRes.body.members[0];
    expect(member.user).toBeDefined();
    expect(member.user.name).toBeDefined();
  });

  test("rejects non-member access", async () => {
    const owner = await registerAndGetToken("Owner");
    const stranger = await registerAndGetToken("Stranger");

    const createRes = await req(
      "POST",
      "/workspaces/create",
      { name: "Private" },
      owner.token
    );
    createdWorkspaceIds.push(createRes.body.id);

    const detailRes = await req(
      "GET",
      `/workspaces/${createRes.body.id}`,
      undefined,
      stranger.token
    );

    expect(detailRes.status).toBe(403);
  });

  test("rejects nonexistent workspace", async () => {
    const { token } = await registerAndGetToken();

    const detailRes = await req(
      "GET",
      "/workspaces/nonexistent-99999",
      undefined,
      token
    );

    expect(detailRes.status).toBe(404);
  });
});

describe("Workspaces: Member Management", () => {
  // Helper: create workspace + add a member directly via service (bypasses invite flow)
  async function setupWorkspaceWithMember() {
    const owner = await registerAndGetToken("Owner");
    const member = await registerAndGetToken("Member");

    const createRes = await req(
      "POST",
      "/workspaces/create",
      { name: "Mgmt Test" },
      owner.token
    );
    createdWorkspaceIds.push(createRes.body.id);
    const workspaceId = createRes.body.id;

    // Add member directly via service
    await joinWorkspace(workspaceId, member.user.id);

    return { owner, member, workspaceId };
  }

  // Helper: add user to workspace as a member via service
  async function addMember(workspaceId: string, userId: string) {
    await joinWorkspace(workspaceId, userId);
  }

  test("owner changes member → admin", async () => {
    const { owner, member, workspaceId } = await setupWorkspaceWithMember();

    const res = await req(
      "POST",
      `/workspaces/${workspaceId}/members/${member.user.id}/role`,
      { role: "admin" },
      owner.token
    );
    expect(res.status).toBe(200);

    // Verify role changed
    const detail = await req("GET", `/workspaces/${workspaceId}`, undefined, owner.token);
    const updated = detail.body.members.find((m: any) => m.userId === member.user.id);
    expect(updated.role).toBe("admin");
  });

  test("owner demotes admin → member", async () => {
    const { owner, member, workspaceId } = await setupWorkspaceWithMember();

    // Promote first
    await req(
      "POST",
      `/workspaces/${workspaceId}/members/${member.user.id}/role`,
      { role: "admin" },
      owner.token
    );

    // Demote
    const res = await req(
      "POST",
      `/workspaces/${workspaceId}/members/${member.user.id}/role`,
      { role: "member" },
      owner.token
    );
    expect(res.status).toBe(200);

    const detail = await req("GET", `/workspaces/${workspaceId}`, undefined, owner.token);
    const updated = detail.body.members.find((m: any) => m.userId === member.user.id);
    expect(updated.role).toBe("member");
  });

  test("admin cannot change another admin's role", async () => {
    const owner = await registerAndGetToken("Owner");
    const admin1 = await registerAndGetToken("Admin1");
    const admin2 = await registerAndGetToken("Admin2");

    const createRes = await req(
      "POST",
      "/workspaces/create",
      { name: "Admin Conflict" },
      owner.token
    );
    createdWorkspaceIds.push(createRes.body.id);
    const workspaceId = createRes.body.id;

    await addMember(workspaceId, admin1.user.id);
    await addMember(workspaceId, admin2.user.id);

    // Promote both to admin
    await req(
      "POST",
      `/workspaces/${workspaceId}/members/${admin1.user.id}/role`,
      { role: "admin" },
      owner.token
    );
    await req(
      "POST",
      `/workspaces/${workspaceId}/members/${admin2.user.id}/role`,
      { role: "admin" },
      owner.token
    );

    // Admin1 tries to change Admin2's role
    const res = await req(
      "POST",
      `/workspaces/${workspaceId}/members/${admin2.user.id}/role`,
      { role: "member" },
      admin1.token
    );
    expect(res.status).toBe(403);
  });

  test("member cannot change roles", async () => {
    const { member, owner, workspaceId } = await setupWorkspaceWithMember();

    const res = await req(
      "POST",
      `/workspaces/${workspaceId}/members/${owner.user.id}/role`,
      { role: "member" },
      member.token
    );
    expect(res.status).toBe(403);
  });

  test("cannot change owner's role", async () => {
    const { owner, workspaceId } = await setupWorkspaceWithMember();

    const res = await req(
      "POST",
      `/workspaces/${workspaceId}/members/${owner.user.id}/role`,
      { role: "admin" },
      owner.token
    );
    expect(res.status).toBe(403);
  });

  test("cannot set role to 'owner'", async () => {
    const { owner, member, workspaceId } = await setupWorkspaceWithMember();

    const res = await req(
      "POST",
      `/workspaces/${workspaceId}/members/${member.user.id}/role`,
      { role: "owner" },
      owner.token
    );
    expect(res.status).toBe(400);
  });

  test("owner removes a member", async () => {
    const { owner, member, workspaceId } = await setupWorkspaceWithMember();

    const res = await req(
      "DELETE",
      `/workspaces/${workspaceId}/members/${member.user.id}`,
      undefined,
      owner.token
    );
    expect(res.status).toBe(200);

    // Verify member is gone
    const detail = await req("GET", `/workspaces/${workspaceId}`, undefined, owner.token);
    const found = detail.body.members.find((m: any) => m.userId === member.user.id);
    expect(found).toBeUndefined();
  });

  test("admin removes a member", async () => {
    const owner = await registerAndGetToken("Owner");
    const admin = await registerAndGetToken("Admin");
    const member = await registerAndGetToken("Member");

    const createRes = await req(
      "POST",
      "/workspaces/create",
      { name: "Admin Remove" },
      owner.token
    );
    createdWorkspaceIds.push(createRes.body.id);
    const workspaceId = createRes.body.id;

    await addMember(workspaceId, admin.user.id);
    await addMember(workspaceId, member.user.id);

    // Promote to admin
    await req(
      "POST",
      `/workspaces/${workspaceId}/members/${admin.user.id}/role`,
      { role: "admin" },
      owner.token
    );

    // Admin removes member
    const res = await req(
      "DELETE",
      `/workspaces/${workspaceId}/members/${member.user.id}`,
      undefined,
      admin.token
    );
    expect(res.status).toBe(200);
  });

  test("admin cannot remove another admin", async () => {
    const owner = await registerAndGetToken("Owner");
    const admin1 = await registerAndGetToken("Admin1");
    const admin2 = await registerAndGetToken("Admin2");

    const createRes = await req(
      "POST",
      "/workspaces/create",
      { name: "Admin No Remove" },
      owner.token
    );
    createdWorkspaceIds.push(createRes.body.id);
    const workspaceId = createRes.body.id;

    await addMember(workspaceId, admin1.user.id);
    await addMember(workspaceId, admin2.user.id);

    await req(
      "POST",
      `/workspaces/${workspaceId}/members/${admin1.user.id}/role`,
      { role: "admin" },
      owner.token
    );
    await req(
      "POST",
      `/workspaces/${workspaceId}/members/${admin2.user.id}/role`,
      { role: "admin" },
      owner.token
    );

    const res = await req(
      "DELETE",
      `/workspaces/${workspaceId}/members/${admin2.user.id}`,
      undefined,
      admin1.token
    );
    expect(res.status).toBe(403);
  });

  test("cannot remove owner", async () => {
    const { member, owner, workspaceId } = await setupWorkspaceWithMember();

    // Promote member to admin so they can attempt removal
    await req(
      "POST",
      `/workspaces/${workspaceId}/members/${member.user.id}/role`,
      { role: "admin" },
      owner.token
    );

    const res = await req(
      "DELETE",
      `/workspaces/${workspaceId}/members/${owner.user.id}`,
      undefined,
      member.token
    );
    expect(res.status).toBe(403);
  });

  test("member cannot remove anyone", async () => {
    const owner = await registerAndGetToken("Owner");
    const member1 = await registerAndGetToken("Member1");
    const member2 = await registerAndGetToken("Member2");

    const createRes = await req(
      "POST",
      "/workspaces/create",
      { name: "Member No Remove" },
      owner.token
    );
    createdWorkspaceIds.push(createRes.body.id);
    const workspaceId = createRes.body.id;

    await addMember(workspaceId, member1.user.id);
    await addMember(workspaceId, member2.user.id);

    const res = await req(
      "DELETE",
      `/workspaces/${workspaceId}/members/${member2.user.id}`,
      undefined,
      member1.token
    );
    expect(res.status).toBe(403);
  });

  test("removed user loses access", async () => {
    const { owner, member, workspaceId } = await setupWorkspaceWithMember();

    // Remove member
    await req(
      "DELETE",
      `/workspaces/${workspaceId}/members/${member.user.id}`,
      undefined,
      owner.token
    );

    // Member tries to access workspace
    const res = await req(
      "GET",
      `/workspaces/${workspaceId}`,
      undefined,
      member.token
    );
    expect(res.status).toBe(403);
  });
});
