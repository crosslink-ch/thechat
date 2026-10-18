import { withDatabaseContext, withWorkerDatabaseContext } from '../db/index';
import { asFixtureBot, joinFixtureWorkspace } from '../test-context';
import { afterAll, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { eq, inArray } from "drizzle-orm";
import { authRoutes } from "../auth";

import { db } from "../db/testing";
import { users, workspaces } from "../db/schema";
import {
  createWorkspace,
  joinWorkspace,
  removeMember,
} from "../services/workspaces";
import { createOrGetDm } from "../services/conversations";

import { wsRoutes, __wsResourceInternalsForTests } from ".";
const app = new Elysia()
  .use(authRoutes)
  .use(wsRoutes)
  .listen({ hostname: "127.0.0.1", port: 0 });
const base = `http://127.0.0.1:${app.server!.port}`;
const ids: string[] = [],
  wids: string[] = [];
afterAll(async () => {
  app.server!.stop(true);
  if (wids.length)
    await db.delete(workspaces).where(inArray(workspaces.id, wids));
  if (ids.length) await db.delete(users).where(inArray(users.id, ids));
});
async function register(name: string) {
  const res = await fetch(base + "/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      email: `realtime-${crypto.randomUUID()}@example.test`,
      password: "synthetic-password123",
    }),
  });
  expect(res.status).toBe(200);
  const s: any = await res.json();
  ids.push(s.user.id);
  return s;
}
async function connect(token: string) {
  const ws = new WebSocket(base.replace("http", "ws") + "/ws");
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("open failed"));
  });
  const events: any[] = [];
  ws.onmessage = (ev) => events.push(JSON.parse(String(ev.data)));
  ws.send(JSON.stringify({ type: "auth", token }));
  await until(() => events.some((e) => e.type === "auth_ok"));
  return { ws, events };
}
async function until(predicate: () => boolean) {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("deadline");
    await Bun.sleep(10);
  }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { resolve, promise };
}

test("captured DM fanout is denied when member removal commits during session revalidation", async () => {
  const owner = await register("Owner"),
    member = await register("Member");
  const workspace = await withDatabaseContext({actorId:owner.user.id,scope:'actor'}, () => createWorkspace("Realtime revocation", owner.user.id));
  wids.push(workspace.id);
  await withDatabaseContext({actorId:member.user.id,scope:'actor'}, () => joinFixtureWorkspace(workspace.id, member.user.id));
  const dm = await withDatabaseContext({actorId:owner.user.id,scope:'actor'}, () => createOrGetDm(workspace.id, owner.user.id, member.user.id));
  const { ws, events } = await connect(member.accessToken);
  await Bun.sleep(80);
  events.length = 0;
  const entered = deferred(),
    release = deferred();
  const pending = __wsResourceInternalsForTests.deliverToLocalUser(
    member.user.id,
    {
      type: "typing",
      conversationId: dm.id,
      threadId: null,
      userId: owner.user.id,
      userName: "secret sentinel",
    },
    {
      beforeResourceAuthorization: async () => {
        entered.resolve();
        await release.promise;
      },
    },
  );
  try {
    await entered.promise;
    await withDatabaseContext({actorId:owner.user.id,scope:'actor'}, () => removeMember(workspace.id, owner.user.id, member.user.id));
  } finally {
    release.resolve();
  }
  await pending;
  await Bun.sleep(100);
  expect(events.filter((e) => e.type === "typing")).toHaveLength(0);
  await __wsResourceInternalsForTests.deliverToLocalUser(member.user.id, {
    type: "typing",
    conversationId: dm.id,
    threadId: null,
    userId: owner.user.id,
    userName: "second sentinel",
  });
  await Bun.sleep(80);
  expect(events.filter((e) => e.type === "typing")).toHaveLength(0);
  // Safe invalidation contains only resource identifiers, not resource content.
  await __wsResourceInternalsForTests.deliverToLocalUser(member.user.id, {
    type: "member_removed",
    workspaceId: workspace.id,
    userId: member.user.id,
  });
  await until(() => events.some((e) => e.type === "member_removed"));
  ws.close();
});

test("captured presence peers are revalidated after losing the last shared workspace", async () => {
  const owner = await register("Presence Owner"),
    member = await register("Presence Member");
  const workspace = await withDatabaseContext({actorId:owner.user.id,scope:'actor'}, () => createWorkspace("Presence revocation", owner.user.id));
  wids.push(workspace.id);
  await withDatabaseContext({actorId:member.user.id,scope:'actor'}, () => joinFixtureWorkspace(workspace.id, member.user.id));
  const { ws, events } = await connect(member.accessToken);
  await Bun.sleep(80);
  events.length = 0;
  await withDatabaseContext({actorId:owner.user.id,scope:'actor'}, () => removeMember(workspace.id, owner.user.id, member.user.id));
  await __wsResourceInternalsForTests.deliverToLocalUser(member.user.id, {
    type: "presence_changed",
    userId: owner.user.id,
    online: true,
  });
  await Bun.sleep(100);
  expect(events.filter((e) => e.type === "presence_changed")).toHaveLength(0);
  ws.close();
});
