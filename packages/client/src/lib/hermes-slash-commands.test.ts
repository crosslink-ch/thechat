import { describe, expect, it } from "vitest";
import {
  HERMES_FALLBACK_SLASH_COMMANDS,
  buildHermesSlashCommands,
  canonicalHermesSlashCommand,
  filterHermesSlashCommands,
  parseHermesSlashCommand,
  slashCommandRequiresArgs,
} from "./hermes-slash-commands";

describe("buildHermesSlashCommands", () => {
  it("falls back to the built-in list when the bot registered nothing", () => {
    expect(buildHermesSlashCommands(null)).toBe(HERMES_FALLBACK_SLASH_COMMANDS);
    expect(buildHermesSlashCommands([])).toBe(HERMES_FALLBACK_SLASH_COMMANDS);
  });

  it("maps registered commands and prefixes slashes", () => {
    const commands = buildHermesSlashCommands([
      {
        command: "new",
        description: "Start a new session",
        argsHint: "[name]",
        category: "Session",
        aliases: ["reset"],
      },
    ]);

    expect(commands[0]).toMatchObject({
      command: "/new",
      description: "Start a new session",
      argsHint: "[name]",
      category: "Session",
      aliases: ["/reset"],
    });
  });

  it("overrides /branch with the local task-branching behavior", () => {
    const commands = buildHermesSlashCommands([
      { command: "branch", description: "Branch the current session", aliases: ["fork"] },
    ]);

    const branch = commands.find((command) => command.command === "/branch");
    expect(branch).toMatchObject({
      local: true,
      description: "Create a new task branched from this task.",
      aliases: ["/fork"],
    });
  });

  it("appends local commands missing from the registered list", () => {
    const commands = buildHermesSlashCommands([
      { command: "help", description: "Show help" },
    ]);

    expect(commands.map((command) => command.command)).toEqual(["/help", "/branch"]);
    expect(commands[1].local).toBe(true);
  });

  it("keeps /branch local in the fallback list", () => {
    const branch = HERMES_FALLBACK_SLASH_COMMANDS.find(
      (command) => command.command === "/branch",
    );
    expect(branch).toMatchObject({
      local: true,
      description: "Create a new task branched from this task.",
    });
  });
});

describe("filterHermesSlashCommands", () => {
  const commands = buildHermesSlashCommands([
    { command: "new", description: "New session", aliases: ["reset"] },
    { command: "news", description: "Show news" },
    { command: "status", description: "Show status" },
  ]);

  it("lists every command when only the slash is typed", () => {
    expect(filterHermesSlashCommands("/", commands)).toHaveLength(commands.length);
  });

  it("matches canonical names by prefix", () => {
    expect(filterHermesSlashCommands("/ne", commands).map((c) => c.command)).toEqual([
      "/new",
      "/news",
    ]);
  });

  it("matches aliases by prefix", () => {
    expect(filterHermesSlashCommands("/res", commands).map((c) => c.command)).toEqual([
      "/new",
    ]);
  });

  it("closes once arguments are being typed", () => {
    expect(filterHermesSlashCommands("/new ", commands)).toEqual([]);
    expect(filterHermesSlashCommands("/new name", commands)).toEqual([]);
  });

  it("does not open for plain text", () => {
    expect(filterHermesSlashCommands("hello", commands)).toEqual([]);
    expect(filterHermesSlashCommands("", commands)).toEqual([]);
  });
});

describe("canonicalHermesSlashCommand", () => {
  const commands = buildHermesSlashCommands([
    { command: "new", description: "New session", aliases: ["reset"] },
    { command: "branch", description: "Branch", aliases: ["fork"] },
  ]);

  it("resolves canonical names and aliases", () => {
    expect(canonicalHermesSlashCommand("/new", commands)).toBe("/new");
    expect(canonicalHermesSlashCommand("/reset", commands)).toBe("/new");
    expect(canonicalHermesSlashCommand("/fork", commands)).toBe("/branch");
  });

  it("returns null for unknown commands", () => {
    expect(canonicalHermesSlashCommand("/unknown", commands)).toBeNull();
  });
});

describe("slashCommandRequiresArgs", () => {
  it("requires args only for <required> hints", () => {
    expect(
      slashCommandRequiresArgs({ command: "/queue", description: "", argsHint: "<prompt>" }),
    ).toBe(true);
    expect(
      slashCommandRequiresArgs({ command: "/new", description: "", argsHint: "[name]" }),
    ).toBe(false);
    expect(slashCommandRequiresArgs({ command: "/help", description: "" })).toBe(false);
  });
});

describe("parseHermesSlashCommand", () => {
  it("parses command and args", () => {
    expect(parseHermesSlashCommand("/queue do the thing")).toEqual({
      raw: "/queue do the thing",
      command: "/queue",
      args: "do the thing",
    });
  });

  it("returns null for non-commands", () => {
    expect(parseHermesSlashCommand("hello")).toBeNull();
    expect(parseHermesSlashCommand("//weird")).toBeNull();
  });
});
