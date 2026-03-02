import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../task-runner", () => ({
  runTask: vi.fn(),
}));

import { runTask } from "../task-runner";
import { taskTool } from "./task";

const mockRunTask = vi.mocked(runTask);

describe("taskTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes context cwd through to task runner", async () => {
    mockRunTask.mockResolvedValueOnce("done");

    const controller = new AbortController();
    const result = await taskTool.execute(
      { prompt: "Do the thing" },
      {
        signal: controller.signal,
        convId: "conv-123",
        cwd: "/repo/project-a",
      },
    );

    expect(mockRunTask).toHaveBeenCalledWith(
      "Do the thing",
      controller.signal,
      "conv-123",
      "/repo/project-a",
    );
    expect(result).toEqual({ success: true, output: "done" });
  });

  it("returns structured error when task runner throws", async () => {
    mockRunTask.mockRejectedValueOnce(new Error("boom"));

    const result = await taskTool.execute({ prompt: "fail" });

    expect(result).toEqual({ success: false, error: "Error: boom" });
  });
});
