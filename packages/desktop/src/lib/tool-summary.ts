import type { MessagePart } from "@thechat/shared";

type ToolCallPart = Extract<MessagePart, { type: "tool-call" }>;

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
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
    default:
      return call.toolName;
  }
}
