import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { McpToolInfo, ToolDefinition } from "../core/types";

export function useMcpTools(): ToolDefinition[] {
  const [mcpTools, setMcpTools] = useState<ToolDefinition[]>([]);

  useEffect(() => {
    setMcpTools([]);

    const unlistenPromise = listen<McpToolInfo[]>("mcp-tools-ready", (event) => {
      const newTools: ToolDefinition[] = event.payload.map((info) => ({
        name: `${info.server}__${info.name}`,
        description: info.description,
        parameters: info.input_schema as Record<string, unknown>,
        execute: (args: Record<string, unknown>) =>
          invoke<string>("mcp_call_tool", {
            server: info.server,
            tool: info.name,
            args,
          }),
      }));
      setMcpTools((prev) => {
        const existing = new Set(prev.map((t) => t.name));
        const unique = newTools.filter((t) => !existing.has(t.name));
        return unique.length > 0 ? [...prev, ...unique] : prev;
      });
    });

    invoke("mcp_initialize").catch((e) =>
      console.error("MCP initialization failed:", e),
    );

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
      invoke("mcp_shutdown").catch(() => {});
    };
  }, []);

  return mcpTools;
}
