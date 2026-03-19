import { fetch } from "@tauri-apps/plugin-http";
import TurndownService from "turndown";
import { requestPermission } from "../permission";
import type { ToolExecutionContext } from "../types";
import { defineTool } from "./define";

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5MB
const DEFAULT_TIMEOUT = 30_000; // 30 seconds
const MAX_TIMEOUT = 120_000; // 2 minutes

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

export const webFetchTool = defineTool({
  name: "webfetch",
  description: `Fetch content from a URL and return it as markdown, text, or HTML.

- Takes a URL and optional format (default: "markdown")
- Converts HTML pages to the requested format automatically
- Read-only — does not modify any files
- The URL must start with http:// or https://
- Results may be truncated if the content is very large
- Use this when you need to read a web page, documentation, or API response`,
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL to fetch content from",
      },
      format: {
        type: "string",
        enum: ["text", "markdown", "html"],
        description:
          'Output format: "markdown" (default), "text", or "html"',
      },
      timeout: {
        type: "number",
        description: "Timeout in seconds (default: 30, max: 120)",
      },
    },
    required: ["url"],
  },
  execute: async (args, context?: ToolExecutionContext) => {
    const {
      url,
      format = "markdown",
      timeout: timeoutSecs,
    } = args as {
      url: string;
      format?: "text" | "markdown" | "html";
      timeout?: number;
    };

    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      throw new Error("URL must start with http:// or https://");
    }

    await requestPermission({
      command: `webfetch ${url}`,
      description: `Fetch content from ${url}`,
      convId: context?.convId,
    });

    const timeout = Math.min(
      (timeoutSecs ?? DEFAULT_TIMEOUT / 1000) * 1000,
      MAX_TIMEOUT,
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    // If the chat loop is aborted, also abort the fetch
    const abortHandler = () => controller.abort();
    context?.signal?.addEventListener("abort", abortHandler, { once: true });

    // Build Accept header based on requested format
    let acceptHeader = "*/*";
    switch (format) {
      case "markdown":
        acceptHeader =
          "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1";
        break;
      case "text":
        acceptHeader =
          "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1";
        break;
      case "html":
        acceptHeader =
          "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, */*;q=0.1";
        break;
    }

    const headers: Record<string, string> = {
      "User-Agent": USER_AGENT,
      Accept: acceptHeader,
      "Accept-Language": "en-US,en;q=0.9",
    };

    try {
      const initial = await fetch(url, {
        signal: controller.signal,
        headers,
      });

      // Retry with honest UA if blocked by Cloudflare bot detection
      const response =
        initial.status === 403 &&
        initial.headers.get("cf-mitigated") === "challenge"
          ? await fetch(url, {
              signal: controller.signal,
              headers: { ...headers, "User-Agent": "thechat" },
            })
          : initial;

      clearTimeout(timer);

      if (!response.ok) {
        throw new Error(
          `Request failed with status code: ${response.status}`,
        );
      }

      // Check content length before downloading
      const contentLength = response.headers.get("content-length");
      if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
        throw new Error("Response too large (exceeds 5MB limit)");
      }

      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength > MAX_RESPONSE_SIZE) {
        throw new Error("Response too large (exceeds 5MB limit)");
      }

      const contentType = response.headers.get("content-type") || "";
      const mime = contentType.split(";")[0]?.trim().toLowerCase() || "";

      const content = new TextDecoder().decode(arrayBuffer);

      // Convert based on requested format and actual content type
      if (format === "markdown" && contentType.includes("text/html")) {
        return {
          url,
          content_type: mime,
          content: convertHTMLToMarkdown(content),
        };
      }

      if (format === "text" && contentType.includes("text/html")) {
        return {
          url,
          content_type: mime,
          content: extractTextFromHTML(content),
        };
      }

      return {
        url,
        content_type: mime,
        content,
      };
    } finally {
      clearTimeout(timer);
      context?.signal?.removeEventListener("abort", abortHandler);
    }
  },
});

function extractTextFromHTML(html: string): string {
  // Simple tag-stripping approach that works in browser context
  const doc = new DOMParser().parseFromString(html, "text/html");

  // Remove script, style, and other non-content elements
  for (const tag of ["script", "style", "noscript", "iframe", "object", "embed"]) {
    for (const el of doc.querySelectorAll(tag)) {
      el.remove();
    }
  }

  return (doc.body.textContent || "").trim();
}

function convertHTMLToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  });
  turndownService.remove(["script", "style", "meta", "link"]);
  return turndownService.turndown(html);
}
