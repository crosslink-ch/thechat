import { describe, expect, test } from "bun:test";
import { ClamAvScanner } from "./scanner";

const integrationTest =
  process.env.CLAMAV_INTEGRATION === "1" ? test : test.skip;

describe("ClamAV integration", () => {
  integrationTest("classifies clean and EICAR payloads", async () => {
    const scanner = new ClamAvScanner({
      host: process.env.CLAMAV_HOST ?? "127.0.0.1",
      port: Number.parseInt(process.env.CLAMAV_PORT ?? "3310", 10),
      timeoutMs: 10_000,
      maxBytes: 25 * 1024 * 1024,
    });

    await expect(
      scanner.scan(new TextEncoder().encode("ordinary attachment contents")),
    ).resolves.toEqual({ status: "clean" });

    // Keep the harmless EICAR signature fragmented in source so endpoint
    // scanners do not quarantine the repository checkout itself.
    const eicar = [
      "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-",
      "STANDARD-ANTIVIRUS-TEST-FILE!$H+H*",
    ].join("");
    const infected = await scanner.scan(new TextEncoder().encode(eicar));
    expect(infected.status).toBe("infected");
    if (infected.status === "infected") {
      expect(infected.signature).toContain("Eicar");
    }
  });
});
