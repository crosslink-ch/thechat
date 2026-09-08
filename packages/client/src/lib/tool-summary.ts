import type { MessagePart } from "@thechat/shared";

type ToolCallPart = Extract<MessagePart, { type: "tool-call" }>;

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

function truncateValue(value: unknown, maxLen: number): string {
  if (typeof value === "string") {
    return value.length > maxLen ? value.slice(0, maxLen - 3) + "..." : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.length} items]`;
  }
  if (value && typeof value === "object") {
    return "{...}";
  }
  return String(value);
}

function formatArgsSummary(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "";

  const parts: string[] = [];
  let totalLen = 0;
  for (const [key, value] of entries) {
    const valStr = truncateValue(value, 40);
    const part = `${key}=${valStr}`;
    if (totalLen + part.length > 80 && parts.length > 0) {
      parts.push("…");
      break;
    }
    parts.push(part);
    totalLen += part.length + 2; // account for ", " separator
  }
  return parts.join(", ");
}

export function formatToolSummary(call: ToolCallPart): string {
  const { args } = call;

  switch (call.toolName) {
    case "read": {
      const filePath = args.file_path as string | undefined;
      return filePath ? `Read ${basename(filePath)}` : "Read";
    }
    case "write": {
      const filePath = args.file_path as string | undefined;
      return filePath ? `Write ${basename(filePath)}` : "Write";
    }
    case "edit":
    case "multiedit": {
      const filePath = args.file_path as string | undefined;
      return filePath ? `Edit ${basename(filePath)}` : "Edit";
    }
    case "shell": {
      const command = args.command as string | undefined;
      if (!command) return "Shell";
      const truncated =
        command.length > 60 ? command.slice(0, 57) + "..." : command;
      return `Shell: ${truncated}`;
    }
    case "glob": {
      const pattern = args.pattern as string | undefined;
      return pattern ? `Glob: ${pattern}` : "Glob";
    }
    case "grep": {
      const pattern = args.pattern as string | undefined;
      return pattern ? `Grep: ${pattern}` : "Grep";
    }
    case "task": {
      const prompt = args.prompt as string | undefined;
      if (!prompt) return "Task";
      const firstLine = prompt.split("\n")[0];
      return `Task: ${firstLine.length > 60 ? firstLine.slice(0, 57) + "..." : firstLine}`;
    }
    case "batch": {
      const toolCalls = args.tool_calls as unknown[] | undefined;
      const count = Array.isArray(toolCalls) ? toolCalls.length : 0;
      return `Batch: ${count} operations`;
    }
    default: {
      const argsSummary = formatArgsSummary(args);
      return argsSummary ? `${call.toolName}: ${argsSummary}` : call.toolName;
    }
  }
}
