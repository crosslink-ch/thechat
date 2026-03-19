import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn(),
}));

vi.mock("../permission", () => ({
  requestPermission: vi.fn(),
}));

import { fetch } from "@tauri-apps/plugin-http";
import { requestPermission } from "../permission";
import { webFetchTool } from "./webfetch";

const mockFetch = vi.mocked(fetch);
const mockRequestPermission = vi.mocked(requestPermission);

function makeResponse(body: string, contentType = "text/html", status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": contentType },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequestPermission.mockResolvedValue(undefined);
});

describe("webFetchTool", () => {
  it("has correct name", () => {
    expect(webFetchTool.name).toBe("webfetch");
  });

  it("rejects non-HTTP URLs", async () => {
    await expect(
      webFetchTool.execute({ url: "ftp://example.com" }),
    ).rejects.toThrow("URL must start with http:// or https://");
  });

  it("requests permission before fetching", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse("hello", "text/plain") as never,
    );

    await webFetchTool.execute({ url: "https://example.com" });

    expect(mockRequestPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "webfetch https://example.com",
      }),
    );
  });

  it("returns plain text as-is", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse("plain text content", "text/plain") as never,
    );

    const result = (await webFetchTool.execute({
      url: "https://example.com/file.txt",
      format: "text",
    })) as { content: string; content_type: string };

    expect(result.content).toBe("plain text content");
    expect(result.content_type).toBe("text/plain");
  });

  it("converts HTML to markdown by default", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse(
        "<html><body><h1>Title</h1><p>Hello world</p></body></html>",
        "text/html; charset=utf-8",
      ) as never,
    );

    const result = (await webFetchTool.execute({
      url: "https://example.com",
    })) as { content: string };

    expect(result.content).toContain("Title");
    expect(result.content).toContain("Hello world");
    // Should be markdown, not HTML
    expect(result.content).not.toContain("<h1>");
  });

  it("extracts plain text from HTML when format=text", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse(
        "<html><body><script>var x=1;</script><p>Hello</p></body></html>",
        "text/html",
      ) as never,
    );

    const result = (await webFetchTool.execute({
      url: "https://example.com",
      format: "text",
    })) as { content: string };

    expect(result.content).toContain("Hello");
    expect(result.content).not.toContain("var x=1");
  });

  it("returns raw HTML when format=html", async () => {
    const html = "<html><body><h1>Title</h1></body></html>";
    mockFetch.mockResolvedValueOnce(
      makeResponse(html, "text/html") as never,
    );

    const result = (await webFetchTool.execute({
      url: "https://example.com",
      format: "html",
    })) as { content: string };

    expect(result.content).toBe(html);
  });

  it("throws on non-OK response", async () => {
    mockFetch.mockResolvedValueOnce(
      makeResponse("Not Found", "text/plain", 404) as never,
    );

    await expect(
      webFetchTool.execute({ url: "https://example.com/missing" }),
    ).rejects.toThrow("status code: 404");
  });

  it("retries with honest UA on Cloudflare challenge", async () => {
    const cfResponse = new Response("blocked", {
      status: 403,
      headers: {
        "content-type": "text/html",
        "cf-mitigated": "challenge",
      },
    });
    const okResponse = makeResponse("success", "text/plain");

    mockFetch
      .mockResolvedValueOnce(cfResponse as never)
      .mockResolvedValueOnce(okResponse as never);

    const result = (await webFetchTool.execute({
      url: "https://example.com",
      format: "text",
    })) as { content: string };

    expect(result.content).toBe("success");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // Second call should have honest UA
    const secondCallHeaders = (mockFetch.mock.calls[1] as unknown[])[1] as {
      headers: Record<string, string>;
    };
    expect(secondCallHeaders.headers["User-Agent"]).toBe("thechat");
  });
});
