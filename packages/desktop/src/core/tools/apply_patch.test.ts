import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("../permission", () => ({
  requestPermission: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { requestPermission } from "../permission";
import { applyPatchTool, parsePatch } from "./apply_patch";

const mockInvoke = vi.mocked(invoke);
const mockRequestPermission = vi.mocked(requestPermission);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("parsePatch", () => {
  it("parses Add File sections", () => {
    const patch = `*** Begin Patch
*** Add File: foo.ts
+export const x = 1;
+export const y = 2;
*** End Patch`;
    const ops = parsePatch(patch);
    expect(ops).toEqual([
      { kind: "add", path: "foo.ts", content: "export const x = 1;\nexport const y = 2;" },
    ]);
  });

  it("parses Delete File sections", () => {
    const patch = `*** Begin Patch
*** Delete File: old.ts
*** End Patch`;
    const ops = parsePatch(patch);
    expect(ops).toEqual([{ kind: "delete", path: "old.ts" }]);
  });

  it("parses Update File with a single hunk", () => {
    const patch = `*** Begin Patch
*** Update File: src/a.ts
@@
 context
-old
+new
*** End Patch`;
    const ops = parsePatch(patch);
    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe("update");
    if (ops[0].kind === "update") {
      expect(ops[0].hunks).toHaveLength(1);
      expect(ops[0].hunks[0].oldLines).toEqual(["context", "old"]);
      expect(ops[0].hunks[0].newLines).toEqual(["context", "new"]);
    }
  });

  it("parses Update File with multiple hunks", () => {
    const patch = `*** Begin Patch
*** Update File: a.ts
@@
-x
+X
@@
-y
+Y
*** End Patch`;
    const ops = parsePatch(patch);
    expect(ops).toHaveLength(1);
    if (ops[0].kind === "update") {
      expect(ops[0].hunks).toHaveLength(2);
    }
  });

  it("parses multi-file patches", () => {
    const patch = `*** Begin Patch
*** Add File: new.ts
+line1
*** Update File: exist.ts
@@
-old
+new
*** Delete File: dead.ts
*** End Patch`;
    const ops = parsePatch(patch);
    expect(ops.map((o) => o.kind)).toEqual(["add", "update", "delete"]);
  });

  it("rejects Update sections without hunks", () => {
    const patch = `*** Begin Patch
*** Update File: a.ts
*** End Patch`;
    expect(() => parsePatch(patch)).toThrow(/no hunks/);
  });

  it("rejects empty patches", () => {
    expect(() => parsePatch(`*** Begin Patch\n*** End Patch`)).toThrow(/no operations/);
  });
});

describe("applyPatchTool", () => {
  it("has correct name", () => {
    expect(applyPatchTool.name).toBe("apply_patch");
  });

  it("requests permission, then writes Add/Update/Delete operations", async () => {
    mockRequestPermission.mockResolvedValueOnce(undefined);
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "fs_read_file_raw") return "context\nold\n";
      if (cmd === "fs_write_file") return { success: true, bytes_written: 1 };
      if (cmd === "fs_format_file") return false;
      if (cmd === "fs_delete_file") return undefined;
      return undefined;
    });

    const patch = `*** Begin Patch
*** Add File: new.ts
+hello
*** Update File: exist.ts
@@
 context
-old
+new
*** Delete File: dead.ts
*** End Patch`;

    const result = (await applyPatchTool.execute({ patch_text: patch })) as {
      total: number;
      applied: number;
      failed: number;
    };

    expect(mockRequestPermission).toHaveBeenCalledTimes(1);
    expect(result.applied).toBe(3);
    expect(result.failed).toBe(0);

    // add: write
    expect(mockInvoke).toHaveBeenCalledWith("fs_write_file", {
      filePath: "new.ts",
      content: "hello",
    });
    // update: read → write the replacement
    expect(mockInvoke).toHaveBeenCalledWith("fs_write_file", {
      filePath: "exist.ts",
      content: "context\nnew\n",
    });
    // delete: delete_file
    expect(mockInvoke).toHaveBeenCalledWith("fs_delete_file", {
      filePath: "dead.ts",
    });
  });

  it("stops at the first failed operation", async () => {
    mockRequestPermission.mockResolvedValueOnce(undefined);
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "fs_read_file_raw") return "totally different content";
      if (cmd === "fs_format_file") return false;
      throw new Error("should not be reached");
    });

    const patch = `*** Begin Patch
*** Update File: a.ts
@@
-old
+new
*** Delete File: b.ts
*** End Patch`;

    const result = (await applyPatchTool.execute({ patch_text: patch })) as {
      applied: number;
      failed: number;
    };

    expect(result.applied).toBe(0);
    expect(result.failed).toBe(1);
  });
});
