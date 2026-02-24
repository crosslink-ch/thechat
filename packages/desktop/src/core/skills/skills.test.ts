import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/path", () => ({
  homeDir: vi.fn(),
  join: vi.fn(async (...parts: string[]) => parts.join("/")),
}));

import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { discoverSkills, loadSkill } from "./index";

const mockInvoke = vi.mocked(invoke);
const mockHomeDir = vi.mocked(homeDir);

beforeEach(() => {
  vi.clearAllMocks();
  // Reset the module-level cache by re-discovering
});

describe("discoverSkills", () => {
  it("includes built-in skills", async () => {
    mockHomeDir.mockResolvedValue("/home/test/");
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_cwd") return "/tmp/test-project";
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
      if (cmd === "get_cwd") return "/tmp/test-project";
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
            "---\nname: custom-skill\ndescription: A custom skill\n---\n# Custom\nDo custom things.\n",
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
      if (cmd === "get_cwd") return "/tmp/project";
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
              "---\nname: dupe\ndescription: Global version\n---\nGlobal content.\n",
            total_lines: 5,
            lines_read: 5,
            truncated: false,
          };
        }
        return {
          content:
            "---\nname: dupe\ndescription: Project version\n---\nProject content.\n",
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
      if (cmd === "get_cwd") return "/tmp/test";
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
      if (cmd === "get_cwd") return "/tmp/test";
      if (cmd === "fs_glob") return { files: [], count: 0, truncated: false };
      return null;
    });

    await discoverSkills();
    const skill = await loadSkill("nonexistent");
    expect(skill).toBeNull();
  });
});
