import { ServiceError } from "../services/errors";
import { incomingWebhookConfig } from "./config";

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
}
function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function textObject(value: unknown) { return text(object(value).text); }
function link(label: string, value: unknown): string {
  const url = text(value);
  // Emit readable text, not raw HTML or caller-controlled Markdown links.
  return /^https?:\/\/[^\s<>]+$/i.test(url) ? `${label} (${url})` : label;
}
function blocks(value: unknown): string[] {
  return array(value).flatMap(item => {
    const block = object(item);
    switch (block.type) {
      case "header": return [textObject(block.text)];
      case "section": return [textObject(block.text), ...array(block.fields).map(textObject)];
      case "context": return array(block.elements).map(textObject);
      case "actions": return array(block.elements).map(element => {
        const button = object(element);
        return button.type === "button" ? link(textObject(button.text), button.url) : "";
      });
      default: return [];
    }
  }).filter(Boolean);
}
function attachment(value: unknown): string[] {
  const item = object(value);
  const rich = blocks(item.blocks);
  const lines = [text(item.pretext), link(text(item.title), item.title_link), text(item.text),
    ...array(item.fields).map(field => {
      const f = object(field);
      return [text(f.title), text(f.value)].filter(Boolean).join(": ");
    }), ...rich, text(item.footer)].filter(Boolean);
  return lines.length ? lines : [text(item.fallback)].filter(Boolean);
}
function readableSlackText(value: string) {
  return value
    .replace(/<(https?:\/\/[^<>|\s]+)(?:\|([^<>]*))?>/g, (_, url: string, label?: string) => label ? `${label} (${url})` : url)
    // Slack broadcasts/IDs are not TheChat mentions or routing directives.
    .replace(/<!(channel|here|everyone)>/g, "@$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export function messageFromPayload(payload: unknown): string {
  const body = object(payload);
  // Slack's top-level text is its portable fallback. Prefer it to duplicating
  // rich blocks (Kuma includes the same alert in both). Accept rich-only posts.
  const content = text(body.text) || [
    ...blocks(body.blocks), ...array(body.attachments).flatMap(attachment),
  ].join("\n\n");
  if (!content) throw new ServiceError("Provide non-empty text or supported Slack blocks/attachments", 400);
  if (content.includes("\u0000")) throw new ServiceError("Message cannot contain NUL characters", 400);
  return readableSlackText(content);
}

/** Read at most the byte budget; do not let Elysia parse/buffer first. */
export async function readWebhookPayload(request: Request): Promise<unknown> {
  const max = incomingWebhookConfig.maxBodyBytes;
  const tooLarge = () => new ServiceError(`Request body exceeds ${max} bytes`, 413);
  const length = request.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > max) throw tooLarge();
  if (request.headers.get("content-encoding") && request.headers.get("content-encoding") !== "identity") {
    throw new ServiceError("Compressed request bodies are not supported", 415);
  }
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new ServiceError("Content-Type must be application/json", 415);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new ServiceError("JSON body required", 400);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > max) { void reader.cancel().catch(() => {}); throw tooLarge(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer)); }
  catch { throw new ServiceError("Invalid JSON body", 400); }
}
