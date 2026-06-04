export interface HermesSlashCommand {
  command: string;
  label: string;
  description: string;
  local?: boolean;
}

export const HERMES_SLASH_COMMANDS: HermesSlashCommand[] = [
  {
    command: "/reset",
    label: "/reset",
    description: "Start fresh Hermes continuity in this task.",
  },
  {
    command: "/new",
    label: "/new",
    description: "Alias for /reset.",
  },
  {
    command: "/branch",
    label: "/branch",
    description: "Create a new task branched from this task.",
    local: true,
  },
  {
    command: "/status",
    label: "/status",
    description: "Show current Hermes runtime status.",
  },
  {
    command: "/usage",
    label: "/usage",
    description: "Show current session usage.",
  },
  {
    command: "/help",
    label: "/help",
    description: "Show Hermes command help.",
  },
  {
    command: "/commands",
    label: "/commands",
    description: "List available Hermes commands.",
  },
  {
    command: "/stop",
    label: "/stop",
    description: "Stop the current Hermes run.",
  },
  {
    command: "/approve",
    label: "/approve",
    description: "Approve a pending Hermes action.",
  },
  {
    command: "/deny",
    label: "/deny",
    description: "Deny a pending Hermes action.",
  },
];

export function parseHermesSlashCommand(text: string) {
  const trimmed = text.trim();
  const match = /^\/([^\s/]+)(?:\s+(.*))?$/.exec(trimmed);
  if (!match) return null;
  return {
    raw: trimmed,
    command: `/${match[1].toLowerCase()}`,
    args: match[2]?.trim() ?? "",
  };
}

export function filterHermesSlashCommands(text: string) {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/")) return [];
  const token = trimmed.split(/\s+/, 1)[0].toLowerCase();
  return HERMES_SLASH_COMMANDS.filter((item) =>
    item.command.startsWith(token),
  ).slice(0, 6);
}

export function isHermesSlashText(text: string) {
  return parseHermesSlashCommand(text) !== null;
}
