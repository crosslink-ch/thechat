import { withDatabaseContext, withWorkerDatabaseContext } from '../db/index';
import { asFixtureBot, joinFixtureWorkspace } from '../test-context';
import { afterAll, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/testing";
import { users, workspaces, eventOutbox } from "../db/schema";
import { authRoutes } from "../auth";
import { workspaceRoutes } from "../workspaces";
import { inviteRoutes } from "../invites";
import { registerTools } from "../mcp/tools";
import { createWorkspace, joinWorkspace } from "./workspaces";
import { LocalRealtimeBus, setRealtimeBusForTests } from "../realtime";
import { createBot } from "./bots";
import { addOwnedBotToWorkspace } from "./bot-workspace-memberships";

test("installation management REST and MCP expose the same human-admin grant contract", async () => {
  const f = await setup();
  const bot = await withDatabaseContext({actorId:f.owner.user.id,scope:'actor'}, () => createBot(
    "Parity bot",
    "https://synthetic.example.test/hook",
    f.owner.user.id,
  ));
  ids.push(bot.userId);
  await withDatabaseContext({actorId:f.owner.user.id,scope:'actor'}, () => addOwnedBotToWorkspace(bot.id, f.workspace.id, f.owner.user.id));
  const path = `/workspaces/${f.workspace.id}/bots/${bot.id}/installation`;
  const read = await req("GET", path, f.owner.accessToken);
  expect(read.status).toBe(200);
  const denied = await req("PUT", path, bot.apiKey, {
    enabled: true,
    channelScope: "all",
    conversationIds: [],
    attachmentAccess: true,
    sharedRuntimeConsent: true,
    approveEndpoint: true,
    expectedRevision: 1,
  });
  expect(denied.status).toBe(403);
  const write = await req("PUT", path, f.owner.accessToken, {
    enabled: true,
    channelScope: "selected",
    conversationIds: [],
    attachmentAccess: false,
    sharedRuntimeConsent: true,
    approveEndpoint: true,
    expectedRevision: 1,
  });
  expect(write.status).toBe(200);
  expect(write.body.revision).toBe(2);
  expect(typeof tools.get("get_bot_installation")).toBe("function");
  const mcpRead = decode(
    await withDatabaseContext({actorId:({ authInfo: f.owner.user }).authInfo.id,scope:'actor'}, () => tools.get("get_bot_installation")(
      { workspaceId: f.workspace.id, botId: bot.id },
      { authInfo: f.owner.user },
    )),
  );
  expect(mcpRead).toEqual(write.body);
  const mcpWrite = decode(
    await withDatabaseContext({actorId:({ authInfo: f.owner.user }).authInfo.id,scope:'actor'}, () => tools.get("update_bot_installation")(
      {
        workspaceId: f.workspace.id,
        botId: bot.id,
        enabled: false,
        channelScope: "all",
        conversationIds: [],
        attachmentAccess: false,
        sharedRuntimeConsent: false,
        expectedRevision: 2,
      },
      { authInfo: f.owner.user },
    )),
  );
  expect(mcpWrite.revision).toBe(3);
  expect((await req("GET", path, f.owner.accessToken)).body).toEqual(mcpWrite);
});

const app = new Elysia().use(authRoutes).use(workspaceRoutes).use(inviteRoutes);
const tools = new Map<string, any>();
registerTools({
  registerTool(name: string, _config: unknown, handler: unknown) {
    tools.set(name, handler);
  },
} as any);
const ids: string[] = [],
  wids: string[] = [];
afterAll(async () => {
  if (wids.length)
    await db.delete(workspaces).where(inArray(workspaces.id, wids));
  if (ids.length) await db.delete(users).where(inArray(users.id, ids));
});
async function req(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
) {
  const r = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await r.text();
  let bodyOut: any;
  try {
    bodyOut = JSON.parse(text);
  } catch {
    bodyOut = text;
  }
  return { status: r.status, body: bodyOut };
}
async function register() {
  const r = await req("POST", "/auth/register", undefined, {
    name: "Parity synthetic",
    email: `parity-${crypto.randomUUID()}@example.test`,
    password: "synthetic-password123",
  });
  expect(r.status).toBe(200);
  ids.push(r.body.user.id);
  return r.body;
}
async function setup() {
  const owner = await register(),
    member = await register();
  const workspace = await withDatabaseContext({actorId:owner.user.id,scope:'actor'}, () => createWorkspace("Parity workspace", owner.user.id));
  wids.push(workspace.id);
  await withDatabaseContext({actorId:member.user.id,scope:'actor'}, () => joinFixtureWorkspace(workspace.id, member.user.id));
  return { owner, member, workspace };
}
function decode(r: any) {
  expect(r.isError).not.toBe(true);
  return JSON.parse(r.content[0].text);
}

test("REST role change uses exactly the shared durable effect with no route rebroadcast", async () => {
  const f = await setup();
  const bus = new LocalRealtimeBus();
  await setRealtimeBusForTests(bus);
  const events: any[] = [];
  await bus.subscribe((e) => {
    events.push(e.event);
  });
  const r = await req(
    "POST",
    `/workspaces/${f.workspace.id}/members/${f.member.user.id}/role`,
    f.owner.accessToken,
    { role: "admin" },
  );
  expect(r.status).toBe(200);
  await Bun.sleep(20);
  expect(events.filter((e) => e.type === "member_role_changed")).toHaveLength(
    1,
  );
});

test("MCP invite, enrollment and removal persist identical service event contracts", async () => {
  const f = await setup(),
    invitee = await register();
  const invite = decode(
    await withDatabaseContext({actorId:({ authInfo: f.owner.user }).authInfo.id,scope:'actor'}, () => tools.get("invite_to_workspace")(
      { workspaceId: f.workspace.id, email: invitee.user.email },
      { authInfo: f.owner.user },
    )),
  );
  let rows = await db
    .select()
    .from(eventOutbox)
    .where(
      and(
        eq(eventOutbox.tenantId, f.workspace.id),
        eq(eventOutbox.eventType, "workspace.lifecycle.notification"),
      ),
    );
  expect(
    rows.some(
      (r) => (r.event.payload.event as any)?.type === "invite_received",
    ),
  ).toBe(true);
  expect(typeof tools.get("accept_workspace_invite")).toBe("function");
  decode(
    await withDatabaseContext({actorId:({ authInfo: invitee.user }).authInfo.id,scope:'actor'}, () => tools.get("accept_workspace_invite")(
      { inviteId: invite.id },
      { authInfo: invitee.user },
    )),
  );
  decode(
    await withDatabaseContext({actorId:({ authInfo: f.owner.user }).authInfo.id,scope:'actor'}, () => tools.get("remove_member")(
      { workspaceId: f.workspace.id, userId: invitee.user.id },
      { authInfo: f.owner.user },
    )),
  );
  rows = await db
    .select()
    .from(eventOutbox)
    .where(
      and(
        eq(eventOutbox.tenantId, f.workspace.id),
        eq(eventOutbox.eventType, "workspace.lifecycle.notification"),
      ),
    );
  expect(
    rows.some((r) => (r.event.payload.event as any)?.type === "member_joined"),
  ).toBe(true);
  expect(
    rows.some(
      (r) =>
        (r.event.payload.event as any)?.type === "member_removed" &&
        (r.event.payload.targetUserIds as string[]).includes(invitee.user.id),
    ),
  ).toBe(true);
});
