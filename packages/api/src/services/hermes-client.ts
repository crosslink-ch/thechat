export interface HermesConnection {
  baseUrl: string;
  apiKey?: string | null;
}

export interface HermesRunRequest {
  input: string;
  session_id?: string;
  instructions?: string | null;
  [key: string]: unknown;
}

export interface HermesRunEvent {
  type: string;
  payload: unknown;
}

function trimTrailingSlashes(value: string) {
  return value.replace(/\/+$/, "");
}

function rootBaseUrl(baseUrl: string) {
  const trimmed = trimTrailingSlashes(baseUrl.trim());
  return trimmed.endsWith("/v1") ? trimmed.slice(0, -3) : trimmed;
}

function v1BaseUrl(baseUrl: string) {
  return `${rootBaseUrl(baseUrl)}/v1`;
}

function headers(connection: HermesConnection, json = false): HeadersInit {
  const result: Record<string, string> = {};
  if (json) result["Content-Type"] = "application/json";
  if (connection.apiKey) result.Authorization = `Bearer ${connection.apiKey}`;
  return result;
}

async function parseJsonResponse(response: Response) {
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = body?.error ?? body?.message ?? `Hermes request failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  return body;
}

export async function getHermesHealth(connection: HermesConnection) {
  const response = await fetch(`${rootBaseUrl(connection.baseUrl)}/health`, {
    headers: headers(connection),
  });
  return parseJsonResponse(response);
}

export async function getHermesCapabilities(connection: HermesConnection) {
  const response = await fetch(`${v1BaseUrl(connection.baseUrl)}/capabilities`, {
    headers: headers(connection),
  });
  return parseJsonResponse(response);
}

export async function startHermesRun(connection: HermesConnection, request: HermesRunRequest) {
  const response = await fetch(`${v1BaseUrl(connection.baseUrl)}/runs`, {
    method: "POST",
    headers: headers(connection, true),
    body: JSON.stringify(request),
  });
  return parseJsonResponse(response);
}

export async function stopHermesRun(connection: HermesConnection, runId: string) {
  const response = await fetch(`${v1BaseUrl(connection.baseUrl)}/runs/${encodeURIComponent(runId)}/stop`, {
    method: "POST",
    headers: headers(connection),
  });
  return parseJsonResponse(response);
}

function parseSseBlock(block: string): HermesRunEvent | null {
  let eventType = "message";
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) eventType = line.slice(6).trim() || "message";
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;
  const data = dataLines.join("\n");
  let payload: unknown = data;
  try {
    payload = JSON.parse(data);
  } catch {
    // Keep raw data for non-JSON SSE events.
  }
  return { type: eventType, payload };
}

export async function streamHermesRunEvents(
  connection: HermesConnection,
  runId: string,
  onEvent: (event: HermesRunEvent) => void | Promise<void>,
) {
  const response = await fetch(`${v1BaseUrl(connection.baseUrl)}/runs/${encodeURIComponent(runId)}/events`, {
    headers: headers(connection),
  });
  if (!response.ok) {
    await parseJsonResponse(response);
  }
  if (!response.body) return;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: !done });

    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const event = parseSseBlock(block);
      if (event) await onEvent(event);
    }

    if (done) break;
  }

  const finalEvent = parseSseBlock(buffer.trim());
  if (finalEvent) await onEvent(finalEvent);
}
