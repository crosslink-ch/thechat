import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { readTool } from "./read";

const mockInvoke = vi.mocked(invoke);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("readTool", () => {
  it("has correct name", () => {
    expect(readTool.name).toBe("read");
  });

  it("calls fs_read_file with correct params", async () => {
    mockInvoke.mockResolvedValueOnce({
      content: "     1\thello\n",
      total_lines: 1,
      lines_read: 1,
      truncated: false,
    });

    const result = await readTool.execute({ file_path: "/tmp/test.txt" });

    expect(mockInvoke).toHaveBeenCalledWith("fs_read_file", {
      filePath: "/tmp/test.txt",
      offset: undefined,
      limit: undefined,
      lineNumbers: true,
    });
    expect(result).toHaveProperty("content");
  });

  it("passes 1-indexed offset and limit through", async () => {
    mockInvoke.mockResolvedValueOnce({
      content: "",
      total_lines: 100,
      lines_read: 10,
      truncated: true,
      next_offset: 16,
    });

    const result = await readTool.execute({
      file_path: "/tmp/test.txt",
      offset: 6,
      limit: 10,
    });

    expect(mockInvoke).toHaveBeenCalledWith("fs_read_file", {
      filePath: "/tmp/test.txt",
      offset: 6,
      limit: 10,
      lineNumbers: true,
    });
    expect(result).toMatchObject({ truncated: true, next_offset: 16 });
  });

  it("does not require permission (read-only)", async () => {
    mockInvoke.mockResolvedValueOnce({
      content: "data",
      total_lines: 1,
      lines_read: 1,
      truncated: false,
    });

    await readTool.execute({ file_path: "/tmp/test.txt" });
    expect(mockInvoke).toHaveBeenCalled();
  });

  it("returns image result for .png files", async () => {
    mockInvoke.mockResolvedValueOnce("iVBORw0KGgo=");

    const result = await readTool.execute({ file_path: "/tmp/screenshot.png" });

    expect(mockInvoke).toHaveBeenCalledWith("load_image_base64", {
      filePath: "/tmp/screenshot.png",
    });
    expect(result).toEqual({
      __image: true,
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,iVBORw0KGgo=",
    });
  });

  it("returns image result for .jpg files", async () => {
    mockInvoke.mockResolvedValueOnce("base64data");

    const result = await readTool.execute({ file_path: "/tmp/photo.jpg" });

    expect(mockInvoke).toHaveBeenCalledWith("load_image_base64", {
      filePath: "/tmp/photo.jpg",
    });
    expect(result).toEqual({
      __image: true,
      mimeType: "image/jpeg",
      dataUrl: "data:image/jpeg;base64,base64data",
    });
  });

  it("returns image result for .webp files", async () => {
    mockInvoke.mockResolvedValueOnce("webpdata");

    const result = await readTool.execute({ file_path: "/tmp/image.webp" });

    expect(result).toEqual({
      __image: true,
      mimeType: "image/webp",
      dataUrl: "data:image/webp;base64,webpdata",
    });
  });

  it("returns PDF result for .pdf files", async () => {
    mockInvoke.mockResolvedValueOnce("JVBERi0xLjQK");

    const result = await readTool.execute({ file_path: "/tmp/docs/report.pdf" });

    expect(mockInvoke).toHaveBeenCalledWith("load_image_base64", {
      filePath: "/tmp/docs/report.pdf",
    });
    expect(result).toEqual({
      __pdf: true,
      mimeType: "application/pdf",
      filename: "report.pdf",
      dataUrl: "data:application/pdf;base64,JVBERi0xLjQK",
    });
  });

  it("reads SVG files as text, not as an image", async () => {
    mockInvoke.mockResolvedValueOnce({
      content: '     1\t<svg xmlns="http://www.w3.org/2000/svg"/>\n',
      total_lines: 1,
      lines_read: 1,
      truncated: false,
    });

    const result = await readTool.execute({ file_path: "/tmp/icon.svg" });

    expect(mockInvoke).toHaveBeenCalledWith("fs_read_file", {
      filePath: "/tmp/icon.svg",
      offset: undefined,
      limit: undefined,
      lineNumbers: true,
    });
    expect(result).toHaveProperty("content");
    expect(result).not.toHaveProperty("__image");
  });

  it("reads non-image files as text normally", async () => {
    mockInvoke.mockResolvedValueOnce({
      content: "     1\tsome code\n",
      total_lines: 1,
      lines_read: 1,
      truncated: false,
    });

    const result = await readTool.execute({ file_path: "/tmp/code.rs" });

    expect(mockInvoke).toHaveBeenCalledWith("fs_read_file", expect.any(Object));
    expect(result).toHaveProperty("content");
    expect(result).not.toHaveProperty("__image");
    expect(result).not.toHaveProperty("__pdf");
  });
});
