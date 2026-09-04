import { afterAll, describe, expect, test } from "bun:test";
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
  version: 1,
  botId: "00000000-0000-4000-8000-000000000001",
  conversationId: "00000000-0000-4000-8000-000000000002",
  endpoint: "ws://127.0.0.1:9119/api/ws",
  gatewayTokenEncrypted: "v1:encrypted",
  userId: "00000000-0000-4000-8000-000000000003",
};

describe.skipIf(!redisUrl)("Redis Hermes proxy ticket store", () => {
  test("passes one grant from the API process to exactly one proxy process", async () => {
    const issued = await issuer!.issue(grant, 30_000);

    expect(await consumer!.consume(issued.ticket)).toMatchObject(grant);
    expect(await issuer!.consume(issued.ticket)).toBeNull();
  });
});
