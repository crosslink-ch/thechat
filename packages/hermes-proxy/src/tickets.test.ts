import { describe, expect, test } from "bun:test";
import {
  InMemoryHermesProxyTicketStore,
  type HermesProxyGrant,
} from "./tickets";

function grant(): Omit<HermesProxyGrant, "expiresAt" | "issuedAt"> {
  return {
    version: 1,
    botId: "00000000-0000-4000-8000-000000000001",
    conversationId: "00000000-0000-4000-8000-000000000002",
    endpoint: "ws://127.0.0.1:9119/api/ws",
    gatewayTokenEncrypted: "v1:encrypted",
    userId: "00000000-0000-4000-8000-000000000003",
  };
}

describe("Hermes proxy tickets", () => {
  test("issues opaque single-use grants", async () => {
    let now = 1_000;
    const store = new InMemoryHermesProxyTicketStore({ now: () => now });

    const issued = await store.issue(grant(), 30_000);

    expect(issued.ticket).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(issued.expiresAt).toBe(31_000);
    expect(await store.consume(issued.ticket)).toEqual({
      ...grant(),
      issuedAt: 1_000,
      expiresAt: 31_000,
    });
    expect(await store.consume(issued.ticket)).toBeNull();
  });

  test("rejects expired, malformed, and unknown tickets", async () => {
    let now = 10_000;
    const store = new InMemoryHermesProxyTicketStore({ now: () => now });
    const issued = await store.issue(grant(), 1_000);
    now = 11_001;

    expect(await store.consume(issued.ticket)).toBeNull();
    expect(await store.consume("not-a-valid-ticket")).toBeNull();
    expect(
      await store.consume("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
    ).toBeNull();
  });
});
