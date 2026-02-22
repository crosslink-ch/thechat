import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../credentials", () => ({
  listCredentials: vi.fn(),
  resolveCredential: vi.fn(),
}));

vi.mock("../permission", () => ({
  requestPermission: vi.fn(),
}));

import { listCredentials, resolveCredential } from "../credentials";
import { requestPermission } from "../permission";
import { getCredentialTool } from "./get_credential";

const mockListCredentials = vi.mocked(listCredentials);
const mockResolveCredential = vi.mocked(resolveCredential);
const mockRequestPermission = vi.mocked(requestPermission);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getCredentialTool", () => {
  it("has correct name", () => {
    expect(getCredentialTool.name).toBe("get_credential");
  });

  it("returns credential after permission is granted", async () => {
    mockListCredentials.mockReturnValue([
      { name: "thechat_api_token", description: "API token", type: "bearer" },
    ]);
    mockRequestPermission.mockResolvedValueOnce(undefined);
    mockResolveCredential.mockResolvedValueOnce({
      credential_name: "thechat_api_token",
      type: "bearer",
      value: "tok_abc123",
    });

    const result = await getCredentialTool.execute({
      name: "thechat_api_token",
      reason: "Need to call TheChat API",
    });

    expect(mockRequestPermission).toHaveBeenCalledWith({
      command: "get_credential: thechat_api_token",
      description: "Need to call TheChat API",
    });
    expect(result).toEqual({
      credential_name: "thechat_api_token",
      type: "bearer",
      value: "tok_abc123",
    });
  });

  it("throws on unknown credential before prompting", async () => {
    mockListCredentials.mockReturnValue([
      { name: "thechat_api_token", description: "API token", type: "bearer" },
    ]);

    await expect(
      getCredentialTool.execute({
        name: "nonexistent",
        reason: "test",
      }),
    ).rejects.toThrow("Unknown credential: nonexistent");

    expect(mockRequestPermission).not.toHaveBeenCalled();
  });

  it("throws when permission is denied", async () => {
    mockListCredentials.mockReturnValue([
      { name: "thechat_api_token", description: "API token", type: "bearer" },
    ]);
    mockRequestPermission.mockRejectedValueOnce(new Error("User denied"));

    await expect(
      getCredentialTool.execute({
        name: "thechat_api_token",
        reason: "Need token",
      }),
    ).rejects.toThrow("User denied");

    expect(mockResolveCredential).not.toHaveBeenCalled();
  });
});
