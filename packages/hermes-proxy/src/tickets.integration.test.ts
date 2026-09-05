import { afterAll, describe, expect, test } from "bun:test";
import Redis from "ioredis";
import crypto from "node:crypto";
import {
  RedisHermesProxyTicketStore,
  type HermesProxyGrantInput,
} from "./tickets";

const redisUrl = process.env.REDIS_URL;
const prefix = `thechat-hermes-proxy-test-${crypto.randomUUID()}`;
const issuer = redisUrl
  ? new RedisHermesProxyTicketStore({ redisUrl, redisKeyPrefix: prefix })
  : null;
const consumer = redisUrl
  ? new RedisHermesProxyTicketStore({ redisUrl, redisKeyPrefix: prefix })
  : null;

afterAll(async () => {
  await Promise.all([issuer?.close(), consumer?.close()]);
});

const grant: HermesProxyGrantInput = {
  policyRevision: "1",
  version: 2,
  botId: "00000000-0000-4000-8000-000000000001",
  conversationId: "00000000-0000-4000-8000-000000000002",
  endpoint: "ws://127.0.0.1:9119/api/ws",
  gatewayTokenEncrypted: "v1:encrypted",
  userId: "00000000-0000-4000-8000-000000000003",
};

describe.skipIf(!redisUrl)("Redis Hermes proxy ticket store", () => {
  test("rejects legacy and unversioned stored grants and missing policy keys", async () => {
    const redis = new Redis(redisUrl!);
    try {
      for (const metadata of [
        { ...grant, version: 1 },
        { ...grant, policyRevision: undefined },
      ]) {
        const ticket = crypto.randomBytes(32).toString("base64url");
        const key = `${prefix}:hermes-proxy-ticket:${crypto.createHash("sha256").update(ticket).digest("hex")}`;
        await redis.set(
          key,
          JSON.stringify({
            ...metadata,
            issuedAt: Date.now(),
            expiresAt: Date.now() + 30000,
          }),
          "PX",
          30000,
        );
        expect(await consumer!.consume(ticket)).toBeNull();
      }
      const input = { ...grant, botId: crypto.randomUUID() };
      const ticket = await issuer!.issue(input);
      await redis.del(`${prefix}:hermes-proxy-policy:${input.botId}`);
      expect(await consumer!.isCurrent(input)).toBe(false);
      expect(await consumer!.consume(ticket.ticket)).toBeNull();
    } finally {
      await redis.quit();
    }
  });

  test("revokes issued capabilities across replicas without stale issuance resetting policy", async () => {
    const first = {
      ...grant,
      version: 2 as const,
      botId: crypto.randomUUID(),
      policyRevision: "1",
    };
    const issued = await issuer!.issue(first);
    await consumer!.publishPolicyRevision(first.botId, "2");
    expect(await issuer!.consume(issued.ticket)).toBeNull();
    await expect(issuer!.issue(first)).rejects.toThrow();
    await expect(
      issuer!.publishPolicyRevision(first.botId, "1"),
    ).rejects.toThrow();
    const current = { ...first, policyRevision: "2" };
    expect(await consumer!.isCurrent(current)).toBe(true);
    expect(await consumer!.isCurrent(first)).toBe(false);
    const fresh = await issuer!.issue(current);
    expect(await consumer!.consume(fresh.ticket)).toMatchObject(current);
  });

  test("passes one grant from the API process to exactly one proxy process", async () => {
    const issued = await issuer!.issue(grant, 30_000);

    expect(await consumer!.consume(issued.ticket)).toMatchObject(grant);
    expect(await issuer!.consume(issued.ticket)).toBeNull();
  });
});
