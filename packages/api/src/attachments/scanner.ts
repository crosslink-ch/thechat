import { createConnection, type Socket } from "node:net";

export type ScanResult =
  | { status: "clean" }
  | { status: "infected"; signature?: string };

export interface AttachmentScanner {
  scan(bytes: Uint8Array): Promise<ScanResult>;
}

export interface ClamAvScannerOptions {
  host: string;
  port: number;
  timeoutMs: number;
  maxBytes: number;
}

/**
 * Fail-closed ClamAV clamd INSTREAM client. The caller supplies an already
 * bounded object, and chunks are independently bounded by the protocol.
 */
export class ClamAvScanner implements AttachmentScanner {
  constructor(private readonly options: ClamAvScannerOptions) {}

  async scan(bytes: Uint8Array): Promise<ScanResult> {
    if (bytes.byteLength > this.options.maxBytes) {
      throw new Error("Attachment exceeds scanner byte limit");
    }

    return new Promise<ScanResult>((resolve, reject) => {
      let settled = false;
      let response = "";
      const socket = createConnection({
        host: this.options.host,
        port: this.options.port,
      });

      const finish = (error?: Error, result?: ScanResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.destroy();
        if (error) reject(error);
        else resolve(result ?? { status: "clean" });
      };
      const timeout = setTimeout(
        () => finish(new Error("ClamAV scan timed out")),
        this.options.timeoutMs,
      );

      socket.on("connect", () => writeInstream(socket, bytes));
      socket.on("data", (chunk) => {
        response += chunk.toString("utf8");
        if (response.includes("\0") || response.includes("\n")) {
          try {
            finish(undefined, parseClamAvResponse(response));
          } catch (error) {
            finish(
              error instanceof Error
                ? error
                : new Error("Invalid ClamAV response"),
            );
          }
        }
      });
      socket.on("error", (error) => finish(error));
      socket.on("end", () => {
        if (settled) return;
        try {
          finish(undefined, parseClamAvResponse(response));
        } catch (error) {
          finish(
            error instanceof Error
              ? error
              : new Error("Invalid ClamAV response"),
          );
        }
      });
    });
  }
}

export function createClamAvScannerFromEnv(
  maxBytes: number,
  env: NodeJS.ProcessEnv = process.env,
): ClamAvScanner {
  return new ClamAvScanner({
    host: env.CLAMAV_HOST?.trim() || "127.0.0.1",
    port: positiveInteger(env.CLAMAV_PORT, 3310),
    timeoutMs: positiveInteger(env.CLAMAV_TIMEOUT_MS, 30_000),
    maxBytes,
  });
}

function writeInstream(socket: Socket, bytes: Uint8Array) {
  socket.write("zINSTREAM\0");
  const chunkSize = 1024 * 1024;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength));
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(chunk.byteLength, 0);
    socket.write(length);
    socket.write(chunk);
  }
  socket.write(Buffer.alloc(4));
}

function parseClamAvResponse(raw: string): ScanResult {
  const response = raw.replace(/\0/g, "").trim();
  if (response.endsWith(" OK")) return { status: "clean" };
  const found = response.match(/:\s*(.+)\s+FOUND$/);
  if (found) return { status: "infected", signature: found[1] };
  throw new Error("ClamAV did not return a conclusive scan result");
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
