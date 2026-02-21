import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/path", () => ({
  homeDir: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { stripLineNumbers, discoverSkills, loadSkill } from "./index";

const mockInvoke = vi.mocked(invoke);
const mockHomeDir = vi.mocked(homeDir);

beforeEach(() => {
  vi.clearAllMocks();
  // Reset the module-level cache by re-discovering
});

describe("stripLineNumbers", () => {
  it("removes cat -n line number prefixes", () => {
    const input = "     1\tFirst line\n     2\tSecond line\n     3\tThird line";
    expect(stripLineNumbers(input)).toBe("First line\nSecond line\nThird line");
  });

  it("handles single-digit and multi-digit line numbers", () => {
    const input = "     1\tLine 1\n   100\tLine 100\n  1000\tLine 1000";
    expect(stripLineNumbers(input)).toBe("Line 1\nLine 100\nLine 1000");
  });

  it("preserves lines without tab-separated numbers", () => {
    const input = "No line numbers here\nJust plain text";
    expect(stripLineNumbers(input)).toBe("No line numbers here\nJust plain text");
  });

  it("handles empty string", () => {
    expect(stripLineNumbers("")).toBe("");
  });
});

describe("discoverSkills", () => {
  it("includes built-in skills", async () => {
    mockHomeDir.mockResolvedValue("/home/test/");
    // pwd command
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "execute_shell_command") return "/tmp/test-project";
      if (cmd === "fs_glob") return { files: [], count: 0, truncated: false };
      return null;
    });

    const skills = await discoverSkills();
    const names = skills.map((s) => s.name);
    expect(names).toContain("create-bot");
  });

  it("discovers filesystem skills", async () => {
    mockHomeDir.mockResolvedValue("/home/test/");
    mockInvoke.mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === "execute_shell_command") return "/tmp/test-project";
      if (cmd === "fs_glob") {
        if (args?.path === "/tmp/test-project/.thechat/skills") {
          return {
            files: ["/tmp/test-project/.thechat/skills/custom/SKILL.md"],
            count: 1,
            truncated: false,
          };
        }
        return { files: [], count: 0, truncated: false };
      }
      if (cmd === "fs_read_file") {
        return {
          content:
            "     1\t---\n     2\tname: custom-skill\n     3\tdescription: A custom skill\n     4\t---\n     5\t# Custom\n     6\tDo custom things.\n",
          total_lines: 6,
          lines_read: 6,
          truncated: false,
        };
      }
      return null;
    });

    const skills = await discoverSkills();
    const custom = skills.find((s) => s.name === "custom-skill");
    expect(custom).toBeDefined();
    expect(custom!.description).toBe("A custom skill");
    expect(custom!.location).toBe("/tmp/test-project/.thechat/skills/custom/SKILL.md");
  });

  it("project skills override global skills on name collision", async () => {
    mockHomeDir.mockResolvedValue("/home/test/");
    mockInvoke.mockImplementation(async (cmd: string, args?: any) => {
      if (cmd === "execute_shell_command") return "/tmp/project";
      if (cmd === "fs_glob") {
        if (args?.path === "/home/test/.config/thechat/skills") {
          return {
            files: ["/home/test/.config/thechat/skills/dupe/SKILL.md"],
            count: 1,
            truncated: false,
          };
        }
        if (args?.path === "/tmp/project/.thechat/skills") {
          return {
            files: ["/tmp/project/.thechat/skills/dupe/SKILL.md"],
            count: 1,
            truncated: false,
          };
        }
        return { files: [], count: 0, truncated: false };
      }
      if (cmd === "fs_read_file") {
        if (args?.filePath?.startsWith("/home/test/")) {
          return {
            content:
              "     1\t---\n     2\tname: dupe\n     3\tdescription: Global version\n     4\t---\n     5\tGlobal content.\n",
            total_lines: 5,
            lines_read: 5,
            truncated: false,
          };
        }
        return {
          content:
            "     1\t---\n     2\tname: dupe\n     3\tdescription: Project version\n     4\t---\n     5\tProject content.\n",
          total_lines: 5,
          lines_read: 5,
          truncated: false,
        };
      }
      return null;
    });

    const skills = await discoverSkills();
    const dupe = skills.find((s) => s.name === "dupe");
    expect(dupe).toBeDefined();
    expect(dupe!.description).toBe("Project version");
    expect(dupe!.location).toBe("/tmp/project/.thechat/skills/dupe/SKILL.md");
  });
});

describe("loadSkill", () => {
  it("returns built-in skill content directly", async () => {
    mockHomeDir.mockResolvedValue("/home/test/");
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "execute_shell_command") return "/tmp/test";
      if (cmd === "fs_glob") return { files: [], count: 0, truncated: false };
      return null;
    });

    await discoverSkills(); // populate cache
    const skill = await loadSkill("create-bot");
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("create-bot");
    expect(skill!.content).toContain("Create Bot Skill");
    expect(skill!.location).toBe("builtin");
  });

  it("returns null for unknown skill name", async () => {
    mockHomeDir.mockResolvedValue("/home/test/");
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "execute_shell_command") return "/tmp/test";
      if (cmd === "fs_glob") return { files: [], count: 0, truncated: false };
      return null;
    });

    await discoverSkills();
    const skill = await loadSkill("nonexistent");
    expect(skill).toBeNull();
  });
});
