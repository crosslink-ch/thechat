import { describe, expect, test } from "bun:test";
import {
  assertHermesGatewayEndpointAllowed,
  authenticatedHermesGatewayUrl,
  hermesGatewayEndpointPolicyFromEnv,
  normalizeHermesGatewayEndpoint,
} from "./endpoint";

describe("Hermes gateway endpoint transport", () => {
  test("normalizes dashboard and WebSocket endpoints without credentials", () => {
    expect(normalizeHermesGatewayEndpoint("http://127.0.0.1:8642")).toBe(
      "ws://127.0.0.1:8642/api/ws",
    );
    expect(normalizeHermesGatewayEndpoint("https://hermes.example/base/")).toBe(
      "wss://hermes.example/base/api/ws",
    );
    expect(normalizeHermesGatewayEndpoint("wss://hermes.example/api/ws/")).toBe(
      "wss://hermes.example/api/ws",
    );
    expect(() => normalizeHermesGatewayEndpoint("ftp://hermes.example")).toThrow(
      "http, https, ws, or wss",
    );
    expect(() =>
      normalizeHermesGatewayEndpoint("wss://user:pass@hermes.example/api/ws"),
    ).toThrow("credentials");
    expect(() =>
      normalizeHermesGatewayEndpoint(
        "wss://hermes.example/api/ws?token=secret",
      ),
    ).toThrow("query string");
  });

  test("adds token auth only when the proxy opens the upstream socket", () => {
    expect(
      authenticatedHermesGatewayUrl(
        "https://hermes.example/base",
        "token with spaces",
      ),
    ).toBe(
      "wss://hermes.example/base/api/ws?token=token+with+spaces",
    );
  });

  test("allows only exact configured upstream origins", () => {
    expect(
      assertHermesGatewayEndpointAllowed(
        "https://hermes.example/base",
        {
          allowedOrigins: ["wss://hermes.example"],
          allowLoopback: false,
        },
      ),
    ).toBe("wss://hermes.example/base/api/ws");

    expect(() =>
      assertHermesGatewayEndpointAllowed(
        "wss://hermes.example:9443/api/ws",
        {
          allowedOrigins: ["wss://hermes.example"],
          allowLoopback: false,
        },
      ),
    ).toThrow("origin is not allowed");
    expect(() =>
      assertHermesGatewayEndpointAllowed(
        "wss://attacker-hermes.example/api/ws",
        {
          allowedOrigins: ["wss://hermes.example"],
          allowLoopback: false,
        },
      ),
    ).toThrow("origin is not allowed");
  });

  test("permits loopback only when the development policy enables it", () => {
    expect(
      assertHermesGatewayEndpointAllowed("http://127.0.0.1:8642", {
        allowedOrigins: [],
        allowLoopback: true,
      }),
    ).toBe("ws://127.0.0.1:8642/api/ws");
    expect(
      assertHermesGatewayEndpointAllowed("ws://[::1]:8642/api/ws", {
        allowedOrigins: [],
        allowLoopback: true,
      }),
    ).toBe("ws://[::1]:8642/api/ws");

    expect(() =>
      assertHermesGatewayEndpointAllowed("http://127.0.0.1:8642", {
        allowedOrigins: [],
        allowLoopback: false,
      }),
    ).toThrow("origin is not allowed");
  });

  test("defaults to deny and requires an explicit loopback development flag", () => {
    expect(hermesGatewayEndpointPolicyFromEnv({})).toEqual({
      allowedOrigins: [],
      allowLoopback: false,
    });
    expect(
      hermesGatewayEndpointPolicyFromEnv({
        THECHAT_HERMES_PROXY_ALLOW_LOOPBACK: "true",
      }),
    ).toEqual({ allowedOrigins: [], allowLoopback: true });
  });
});
