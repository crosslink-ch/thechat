import {
  HERMES_PROXY_PROTOCOL,
  hermesProxyTicketProtocol,
} from "@thechat/hermes-proxy/protocol";
import { JsonRpcGatewayClient } from "./hermes-json-rpc-gateway";

export interface DirectHermesProxyTicket {
  expiresAt: string;
  proxyUrl: string;
  ticket: string;
}

export interface DirectHermesGatewayConnectionOptions {
  issueTicket: (signal?: AbortSignal) => Promise<DirectHermesProxyTicket>;
  signal?: AbortSignal;
  socketFactory?: (url: string, protocols: string[]) => WebSocket;
}

const TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

function validateProxyTicket(value: unknown): DirectHermesProxyTicket {
  if (!value || typeof value !== "object") {
    throw new Error("TheChat returned an invalid Hermes proxy ticket");
  }
  const grant = value as Partial<DirectHermesProxyTicket>;
  if (
    typeof grant.ticket !== "string" ||
    !TICKET_PATTERN.test(grant.ticket) ||
    typeof grant.proxyUrl !== "string" ||
    typeof grant.expiresAt !== "string"
  ) {
    throw new Error("TheChat returned an invalid Hermes proxy ticket");
  }
  const expiresAt = Date.parse(grant.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error("TheChat returned an invalid Hermes proxy ticket");
  }
  let proxyUrl: URL;
  try {
    proxyUrl = new URL(grant.proxyUrl);
  } catch {
    throw new Error("TheChat returned an invalid Hermes proxy URL");
  }
  if (
    (proxyUrl.protocol !== "ws:" && proxyUrl.protocol !== "wss:") ||
    proxyUrl.username ||
    proxyUrl.password ||
    proxyUrl.search ||
    proxyUrl.hash ||
    !proxyUrl.pathname.endsWith("/hermes-proxy")
  ) {
    throw new Error("TheChat returned an invalid Hermes proxy URL");
  }
  return grant as DirectHermesProxyTicket;
}

export async function connectDirectHermesGateway(
  options: DirectHermesGatewayConnectionOptions,
): Promise<JsonRpcGatewayClient> {
  if (options.signal?.aborted) throw abortError();
  const grant = validateProxyTicket(await options.issueTicket(options.signal));
  if (options.signal?.aborted) throw abortError();

  const protocols = [
    HERMES_PROXY_PROTOCOL,
    hermesProxyTicketProtocol(grant.ticket),
  ];
  const client = new JsonRpcGatewayClient({
    closedErrorMessage: "The Hermes proxy connection closed",
    connectErrorMessage: "Could not connect to the Hermes proxy",
    notConnectedErrorMessage: "Hermes proxy is not connected",
    requestIdPrefix: "thechat-",
    socketFactory: (url) =>
      options.socketFactory?.(url, protocols) ?? new WebSocket(url, protocols),
  });

  try {
    if (!options.signal) {
      await client.connect(grant.proxyUrl);
    } else {
      const signal = options.signal;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const onAbort = () => {
          if (settled) return;
          settled = true;
          client.close();
          reject(abortError());
        };
        signal.addEventListener("abort", onAbort, { once: true });
        void client.connect(grant.proxyUrl).then(
          () => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", onAbort);
            resolve();
          },
          (error) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", onAbort);
            reject(error);
          },
        );
      });
    }
    return client;
  } catch (error) {
    client.close();
    throw error;
  }
}
