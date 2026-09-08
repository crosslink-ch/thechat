import type { BotCommandPublic } from "@thechat/shared";

export interface HermesSlashCommand {
  /** Canonical command including the leading slash, e.g. "/new". */
  command: string;
  description: string;
  /** Argument placeholder, e.g. "<prompt>" (required) or "[name]" (optional). */
  argsHint?: string | null;
  /** Grouping label, e.g. "Session". */
  category?: string | null;
  /** Alternative spellings including the leading slash, e.g. ["/reset"]. */
  aliases?: string[];
  /** Handled by the desktop client instead of being forwarded to the bot. */
  local?: boolean;
}

/**
 * Commands the desktop client handles itself. `/branch` is intercepted by the
 * DM route to create a new task thread carrying Hermes branch-session
 * metadata, so its description reflects TheChat semantics rather than the
 * gateway's. These are merged over the registered/fallback list and appended
 * when missing from it.
 */
const LOCAL_COMMANDS: HermesSlashCommand[] = [
  {
    command: "/branch",
    description: "Create a new task branched from this task.",
    argsHint: "[name]",
    category: "Session",
    local: true,
  },
];

function applyLocalCommands(commands: HermesSlashCommand[]): HermesSlashCommand[] {
  const result = commands.map((command) => {
    const local = LOCAL_COMMANDS.find((entry) => entry.command === command.command);
    return local
      ? { ...command, description: local.description, local: true }
      : command;
  });
  for (const local of LOCAL_COMMANDS) {
    if (!result.some((command) => command.command === local.command)) {
      result.push(local);
    }
  }
  return result;
}

/**
 * Used when the bot has not registered its commands (e.g. an older Hermes
 * gateway). Mirrors the gateway-available commands in Hermes'
 * `hermes_cli/commands.py` registry, minus platform-specific entries
 * (/start, /topic) that have no meaning in TheChat.
 */
export const HERMES_FALLBACK_SLASH_COMMANDS: HermesSlashCommand[] = applyLocalCommands([
  { command: "/help", description: "Show available commands", category: "Info" },
  { command: "/new", description: "Start a new session (fresh session ID + history)", argsHint: "[name]", category: "Session", aliases: ["/reset"] },
  { command: "/stop", description: "Stop the current run and kill background processes", category: "Session" },
  { command: "/status", description: "Show session info", category: "Session" },
  { command: "/resume", description: "Resume a previously-named session", argsHint: "[name]", category: "Session" },
  { command: "/sessions", description: "Browse and resume previous sessions", category: "Session" },
  { command: "/model", description: "Switch model for this session", argsHint: "[model]", category: "Configuration" },
  { command: "/branch", description: "Branch the current session (explore a different path)", argsHint: "[name]", category: "Session", aliases: ["/fork"] },
  { command: "/commands", description: "Browse all commands and skills (paginated)", argsHint: "[page]", category: "Info" },
  { command: "/approve", description: "Approve a pending dangerous command", argsHint: "[session|always]", category: "Session" },
  { command: "/deny", description: "Deny a pending dangerous command", category: "Session" },
  { command: "/queue", description: "Queue a prompt for the next turn (doesn't interrupt)", argsHint: "<prompt>", category: "Session", aliases: ["/q"] },
  { command: "/steer", description: "Inject a message after the next tool call without interrupting", argsHint: "<prompt>", category: "Session" },
  { command: "/background", description: "Run a prompt in the background", argsHint: "<prompt>", category: "Session", aliases: ["/bg", "/btw"] },
  { command: "/agents", description: "Show active agents and running tasks", category: "Session", aliases: ["/tasks"] },
  { command: "/retry", description: "Retry the last message (resend to agent)", category: "Session" },
  { command: "/undo", description: "Back up N user turns and re-prompt (default 1)", argsHint: "[N]", category: "Session" },
  { command: "/title", description: "Set a title for the current session", argsHint: "[name]", category: "Session" },
  { command: "/compress", description: "Compress conversation context", argsHint: "[here [N] | focus topic]", category: "Session" },
  { command: "/rollback", description: "List or restore filesystem checkpoints", argsHint: "[number]", category: "Session" },
  { command: "/goal", description: "Set a standing goal Hermes works on across turns", argsHint: "[text | pause | resume | clear | status]", category: "Session" },
  { command: "/subgoal", description: "Add or manage extra criteria on the active goal", argsHint: "[text | remove N | clear]", category: "Session" },
  { command: "/reasoning", description: "Manage reasoning effort and display", argsHint: "[level|show|hide]", category: "Configuration" },
  { command: "/fast", description: "Toggle fast mode", argsHint: "[normal|fast|status]", category: "Configuration" },
  { command: "/voice", description: "Toggle voice mode", argsHint: "[on|off|tts|status]", category: "Configuration" },
  { command: "/personality", description: "Set a predefined personality", argsHint: "[name]", category: "Configuration" },
  { command: "/footer", description: "Toggle runtime-metadata footer on final replies", argsHint: "[on|off|status]", category: "Configuration" },
  { command: "/yolo", description: "Toggle YOLO mode (skip dangerous command approvals)", category: "Configuration" },
  { command: "/usage", description: "Show token usage and rate limits for the current session", category: "Info" },
  { command: "/insights", description: "Show usage insights and analytics", argsHint: "[days]", category: "Info" },
  { command: "/whoami", description: "Show your slash command access (admin / user)", category: "Info" },
  { command: "/profile", description: "Show active profile name and home directory", category: "Info" },
  { command: "/bundles", description: "List skill bundles", category: "Tools & Skills" },
  { command: "/curator", description: "Background skill maintenance", argsHint: "[subcommand]", category: "Tools & Skills" },
  { command: "/kanban", description: "Multi-profile collaboration board", argsHint: "[subcommand]", category: "Tools & Skills" },
  { command: "/reload-mcp", description: "Reload MCP servers from config", category: "Tools & Skills" },
  { command: "/reload-skills", description: "Re-scan skills directory for changes", category: "Tools & Skills" },
  { command: "/sethome", description: "Set this chat as the home channel", category: "Session", aliases: ["/set-home"] },
  { command: "/platform", description: "Pause, resume, or list a failing gateway platform", argsHint: "<pause|resume|list> [name]", category: "Info" },
  { command: "/restart", description: "Gracefully restart the gateway after draining active runs", category: "Session" },
  { command: "/update", description: "Update Hermes Agent to the latest version", category: "Info" },
  { command: "/debug", description: "Upload debug report and get shareable links", category: "Info" },
]);

function withSlash(name: string) {
  return name.startsWith("/") ? name : `/${name}`;
}

/**
 * Build the slash command menu for a Hermes DM. Prefers the commands the bot
 * registered via `POST /bots/me/commands` (Telegram setMyCommands-style) and
 * falls back to the built-in Hermes gateway list.
 */
export function buildHermesSlashCommands(
  registered?: BotCommandPublic[] | null,
): HermesSlashCommand[] {
  if (!registered?.length) return HERMES_FALLBACK_SLASH_COMMANDS;
  return applyLocalCommands(
    registered.map((entry) => ({
      command: withSlash(entry.command),
      description: entry.description,
      argsHint: entry.argsHint ?? null,
      category: entry.category ?? null,
      ...(entry.aliases?.length ? { aliases: entry.aliases.map(withSlash) } : {}),
    })),
  );
}

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

/** Resolve a typed command token (possibly an alias) to its canonical command. */
export function canonicalHermesSlashCommand(
  commandToken: string,
  commands: HermesSlashCommand[],
): string | null {
  const token = commandToken.toLowerCase();
  for (const command of commands) {
    if (command.command === token || command.aliases?.includes(token)) {
      return command.command;
    }
  }
  return null;
}

/**
 * Commands matching the current input, Telegram-style: the menu is open only
 * while the input is a single partial "/token" (it closes once arguments are
 * being typed). Matches canonical names and aliases by prefix.
 */
export function filterHermesSlashCommands(
  text: string,
  commands: HermesSlashCommand[],
): HermesSlashCommand[] {
  const match = /^\/(\S*)$/.exec(text.trimStart());
  if (!match) return [];
  const token = `/${match[1].toLowerCase()}`;
  return commands.filter(
    (command) =>
      command.command.startsWith(token) ||
      command.aliases?.some((alias) => alias.startsWith(token)),
  );
}

/** True when selecting the command should insert it for further typing instead of sending. */
export function slashCommandRequiresArgs(command: HermesSlashCommand): boolean {
  return command.argsHint?.trimStart().startsWith("<") ?? false;
}
