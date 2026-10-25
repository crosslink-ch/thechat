import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import net from "node:net";
import {
  S3BodyIdleTimeoutError,
  S3ObjectStore,
  loadS3TimeoutOptions,
} from "./s3-object-store";

// A local TCP server stands in for S3 so each test can stall at an exact point
// of the HTTP exchange. The real S3ObjectStore and AWS SDK client are used.

type Behaviour =
  | "never-respond"
  | "stall-body"
  | "slow-body"
  | "stall-xml-body"
  | "ok-xml";

let behaviour: Behaviour = "never-respond";
let requests = 0;
const sockets = new Set<net.Socket>();
const timers = new Set<ReturnType<typeof setInterval>>();
let server: net.Server;
let endpoint: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const key of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]) {
    savedEnv[key] = process.env[key];
  }
  process.env.AWS_ACCESS_KEY_ID = "test-access-key-id";
  process.env.AWS_SECRET_ACCESS_KEY = "testtesttesttesttesttesttesttesttesttest";
  delete process.env.AWS_SESSION_TOKEN;

  server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.once("data", () => {
      requests += 1;
      respond(socket);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
});

afterAll(async () => {
  for (const timer of timers) clearInterval(timer);
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function respond(socket: net.Socket) {
  const body = Buffer.alloc(6_000, 97);
  switch (behaviour) {
    case "never-respond":
      return;
    case "stall-body":
      socket.write(
        `HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nContent-Type: application/octet-stream\r\n\r\n`,
      );
      socket.write(body.subarray(0, 1_000));
      return;
    case "slow-body": {
      // Healthy but slow: 6 chunks, one every 150 ms (~900 ms in total),
      // longer than the response timeout but never idle for long.
      socket.write(
        `HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\nContent-Type: application/octet-stream\r\n\r\n`,
      );
      let sent = 0;
      const timer = setInterval(() => {
        socket.write(body.subarray(sent * 1_000, (sent + 1) * 1_000));
        sent += 1;
        if (sent === 6) {
          clearInterval(timer);
          timers.delete(timer);
          socket.end();
        }
      }, 150);
      timers.add(timer);
      return;
    }
    case "stall-xml-body":
      socket.write(
        "HTTP/1.1 200 OK\r\nContent-Type: application/xml\r\nContent-Length: 400\r\n\r\n<?xml",
      );
      return;
    case "ok-xml": {
      const xml = "<CopyObjectResult><ETag>\"etag\"</ETag></CopyObjectResult>";
      socket.end(
        `HTTP/1.1 200 OK\r\nContent-Type: application/xml\r\nx-amz-version-id: clean-v1\r\nContent-Length: ${xml.length}\r\n\r\n${xml}`,
      );
      return;
    }
  }
}

function store(timeouts: {
  connectTimeoutMs?: number;
  responseTimeoutMs?: number;
  bodyIdleTimeoutMs?: number;
}) {
  return new S3ObjectStore({
    bucket: "timeouts-bucket",
    region: "eu-central-1",
    endpoint,
    forcePathStyle: true,
    timeouts,
  });
}

async function settleWithin<T>(promise: Promise<T>, capMs: number) {
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<{ kind: "hung" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "hung" }), capMs);
  });
  const outcome = await Promise.race([
    promise.then(
      (value) => ({ kind: "resolved" as const, value }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    ),
    cap,
  ]);
  clearTimeout(timer);
  return { ...outcome, elapsedMs: Date.now() - started };
}

const copyInput = {
  sourceKey: "quarantine/a",
  sourceVersionId: "v1",
  destinationKey: "clean/a",
  mediaType: "text/plain",
};

describe("S3 object store network deadlines", () => {
  test("fails a request whose response headers never arrive", async () => {
    behaviour = "never-respond";
    const outcome = await settleWithin(
      store({ responseTimeoutMs: 300 }).headObject({ key: "k", versionId: "v1" }),
      5_000,
    );
    expect(outcome.kind).toBe("rejected");
    expect(outcome.elapsedMs).toBeLessThan(2_000);
  });

  test("fails a GetObject body that stops sending data", async () => {
    behaviour = "stall-body";
    const outcome = await settleWithin(
      store({ responseTimeoutMs: 5_000, bodyIdleTimeoutMs: 300 }).getObject({
        key: "k",
        versionId: "v1",
        maxBytes: 1_000_000,
      }),
      5_000,
    );
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.error).toBeInstanceOf(S3BodyIdleTimeoutError);
    }
    expect(outcome.elapsedMs).toBeLessThan(2_000);
  });

  test("lets a slow but steady transfer run longer than every network timeout", async () => {
    behaviour = "slow-body";
    const outcome = await settleWithin(
      store({ responseTimeoutMs: 300, bodyIdleTimeoutMs: 400 }).getObject({
        key: "k",
        versionId: "v1",
        maxBytes: 1_000_000,
      }),
      5_000,
    );
    expect(outcome.kind).toBe("resolved");
    if (outcome.kind === "resolved") expect(outcome.value.byteLength).toBe(6_000);
    expect(outcome.elapsedMs).toBeGreaterThan(600);
  });

  test("an aborted attempt stops a GetObject body immediately", async () => {
    behaviour = "stall-body";
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("attempt budget")), 200);
    const outcome = await settleWithin(
      store({ responseTimeoutMs: 5_000, bodyIdleTimeoutMs: 60_000 }).getObject({
        key: "k",
        versionId: "v1",
        maxBytes: 1_000_000,
        signal: controller.signal,
      }),
      5_000,
    );
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect((outcome.error as Error).message).toBe("attempt budget");
    }
    expect(outcome.elapsedMs).toBeLessThan(1_500);
  });

  test("an aborted attempt releases a CopyObject whose XML body stalls", async () => {
    // The SDK reads CopyObject's body internally and, under Bun, its own abort
    // handling does not interrupt that read.
    behaviour = "stall-xml-body";
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("attempt budget")), 200);
    const outcome = await settleWithin(
      store({ responseTimeoutMs: 5_000 }).copyObject({
        ...copyInput,
        signal: controller.signal,
      }),
      5_000,
    );
    expect(outcome.kind).toBe("rejected");
    expect(outcome.elapsedMs).toBeLessThan(1_500);
  });

  test("does not send a request for an already aborted attempt", async () => {
    behaviour = "ok-xml";
    const before = requests;
    const controller = new AbortController();
    controller.abort(new Error("already over"));
    const outcome = await settleWithin(
      store({}).copyObject({ ...copyInput, signal: controller.signal }),
      2_000,
    );
    expect(outcome.kind).toBe("rejected");
    expect(requests).toBe(before);
  });

  test("healthy requests with a signal succeed unchanged", async () => {
    behaviour = "ok-xml";
    const outcome = await settleWithin(
      store({}).copyObject({ ...copyInput, signal: new AbortController().signal }),
      5_000,
    );
    expect(outcome.kind).toBe("resolved");
    if (outcome.kind === "resolved") expect(outcome.value.versionId).toBe("clean-v1");
  });

  test("loads network deadlines from the environment with safe defaults", () => {
    expect(loadS3TimeoutOptions({})).toEqual({
      connectTimeoutMs: 10_000,
      responseTimeoutMs: 30_000,
      bodyIdleTimeoutMs: 30_000,
    });
    expect(
      loadS3TimeoutOptions({
        ATTACHMENT_S3_CONNECT_TIMEOUT_MS: "5000",
        ATTACHMENT_S3_RESPONSE_TIMEOUT_MS: "nope",
        ATTACHMENT_S3_BODY_IDLE_TIMEOUT_MS: "45000",
      }),
    ).toEqual({
      connectTimeoutMs: 5_000,
      responseTimeoutMs: 30_000,
      bodyIdleTimeoutMs: 45_000,
    });
  });
});
