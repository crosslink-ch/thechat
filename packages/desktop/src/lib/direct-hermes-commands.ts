// Execution surfaces are NOT included in commands.catalog. Keep the small
// verified gateway surface here; descriptions and aliases come from Hermes.
// Do not interpret an arbitrary catalog builtin as a prompt or a quick command.
export const GATEWAY_SLASH_COMMANDS = new Set(["approvals", "agents", "background", "debug", "goal", "loop", "personality", "queue", "retry", "rollback", "save", "steer", "tools", "undo", "compress", "usage", "version"]);
export const DIRECT_COMMANDS = new Set(["branch", "fork", "new", "reset", "clear", "stop", "interrupt", "help", "commands", "title", "status", "model", ...GATEWAY_SLASH_COMMANDS]);
export interface DirectCommandCatalog {
  commands: { name: string; description: string }[];
  canon: Map<string, string>;
  dynamic: Set<string>;
}
export function commandParts(command: string) {
  const [name, arg = ""] = command.trim().replace(/^\//, "").split(/\s+(.*)/s);
  return { name: name.toLowerCase(), arg };
}
export function parseCommandCatalog(value: unknown): DirectCommandCatalog {
  const row = object(value);
  const pairs = (value: unknown) => Array.isArray(value) ? value.flatMap(pair => Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string" ? [{ name: pair[0], description: pair[1] }] : []) : [];
  const commands = [...new Map(pairs(row.pairs).map(item => [item.name, item])).values()];
  const canon = new Map(Object.entries(object(row.canon)).flatMap(([alias, name]) => typeof name === "string" ? [[commandParts(alias).name, commandParts(name).name] as const] : []));
  const categories = Array.isArray(row.categories) ? row.categories.map(object) : [];
  const builtin = new Set(categories.filter(category => category.name !== "User commands").flatMap(category => pairs(category.pairs).map(item => commandParts(item.name).name)));
  const dynamic = new Set([
    ...categories.filter(category => category.name === "User commands").flatMap(category => pairs(category.pairs).map(item => commandParts(item.name).name)),
    ...Object.keys(object(row.skills)).map(key => commandParts(key).name),
    // Older catalogs leave skills out of both canon and categories.
    ...commands.map(item => commandParts(item.name).name).filter(name => !builtin.has(name) && !canon.has(name)),
  ]);
  return { commands, canon, dynamic };
}
export function renderCommandResult(result: Record<string, unknown>) {
  const body = typeof result.output === "string" ? result.output : JSON.stringify(result, null, 2);
  return [typeof result.warning === "string" ? `Warning: ${result.warning}` : "", body || "(no output)"].filter(Boolean).join("\n").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
