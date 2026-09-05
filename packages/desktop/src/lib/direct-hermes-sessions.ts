import { z } from "zod";
import {
  connectDirectHermesGateway,
  type DirectHermesGatewayConnectionOptions,
} from "./direct-hermes-gateway";

const sessionListResultSchema = z.object({
  sessions: z.array(
    z.object({
      id: z.string().min(1),
      resolved_id: z.string().nullable().optional(),
      title: z.string().optional().default(""),
      preview: z.string().optional().default(""),
      started_at: z.number().optional().default(0),
      message_count: z.number().optional().default(0),
      source: z.string().optional().default(""),
    }).passthrough(),
  ),
});

export interface DirectHermesSession {
  id: string;
  messageCount: number;
  preview: string;
  resolvedId: string | null;
  source: string;
  startedAt: number;
  title: string;
}

export async function listDirectHermesSessions(
  connection: DirectHermesGatewayConnectionOptions,
): Promise<DirectHermesSession[]> {
  if (connection.signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  const client = await connectDirectHermesGateway(connection);
  try {
    const raw = connection.signal
      ? await client.request<unknown>(
          "session.list",
          { limit: 200 },
          undefined,
          connection.signal,
        )
      : await client.request<unknown>("session.list", { limit: 200 });
    return parseDirectHermesSessions(raw);
  } finally {
    client.close();
  }
}

export function parseDirectHermesSessions(raw: unknown): DirectHermesSession[] {
  const parsed = sessionListResultSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Hermes session.list returned an invalid result");
  return parsed.data.sessions.map((session) => ({
    id: session.id,
    messageCount: session.message_count,
    preview: session.preview,
    resolvedId: session.resolved_id ?? null,
    source: session.source,
    startedAt: session.started_at,
    title: session.title,
  }));
}
