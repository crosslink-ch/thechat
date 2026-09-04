export const HERMES_PROXY_PROTOCOL = "thechat-hermes-proxy-v1";
export const HERMES_PROXY_TICKET_PROTOCOL_PREFIX = "thechat-ticket.";

export function hermesProxyTicketProtocol(ticket: string): string {
  return `${HERMES_PROXY_TICKET_PROTOCOL_PREFIX}${ticket}`;
}

export function hermesProxyTicketFromProtocols(
  header: string | null,
): string | null {
  if (!header) return null;
  const protocols = header.split(",").map((value) => value.trim());
  if (!protocols.includes(HERMES_PROXY_PROTOCOL)) return null;
  const ticketProtocol = protocols.find((value) =>
    value.startsWith(HERMES_PROXY_TICKET_PROTOCOL_PREFIX)
  );
  const ticket = ticketProtocol?.slice(
    HERMES_PROXY_TICKET_PROTOCOL_PREFIX.length,
  ) ?? "";
  return ticket || null;
}
