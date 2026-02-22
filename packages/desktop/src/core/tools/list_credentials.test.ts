import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../credentials", () => ({
  listCredentials: vi.fn(),
}));

import { listCredentials } from "../credentials";
import { listCredentialsTool } from "./list_credentials";

const mockListCredentials = vi.mocked(listCredentials);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listCredentialsTool", () => {
  it("has correct name", () => {
    expect(listCredentialsTool.name).toBe("list_credentials");
  });

  it("returns credentials with count", () => {
    mockListCredentials.mockReturnValue([
      { name: "thechat_api_token", description: "API token", type: "bearer" },
      { name: "github_token", description: "GitHub PAT", type: "api_key" },
    ]);

    const result = listCredentialsTool.execute({}) as {
      credentials: unknown[];
      total: number;
    };

    expect(result.total).toBe(2);
    expect(result.credentials).toEqual([
      { name: "thechat_api_token", description: "API token", type: "bearer" },
      { name: "github_token", description: "GitHub PAT", type: "api_key" },
    ]);
  });

  it("returns empty state when no credentials", () => {
    mockListCredentials.mockReturnValue([]);

    const result = listCredentialsTool.execute({}) as { total: number };
    expect(result.total).toBe(0);
  });
});
