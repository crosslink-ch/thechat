import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DirectHermesAttachmentPreview } from "./DirectHermesAttachmentPreview";
import type { DirectHermesAttachment } from "../lib/direct-hermes-chat";

const png = () => Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE1sAAAAASUVORK5CYII="), char => char.charCodeAt(0));
const attachment = (file?: File): DirectHermesAttachment => ({ id: "local-1", name: file?.name ?? "history.png", size: file?.size ?? 42, type: "image", status: "queued", file });
let jobs: Promise<void>[];
const create = vi.fn<(file: Blob | MediaSource) => string>(() => "blob:local-preview");
const revoke = vi.fn<(url: string) => void>();
beforeEach(() => {
  jobs = [];
  create.mockClear();
  revoke.mockClear();
  vi.stubGlobal("URL", class extends URL { static createObjectURL = create; static revokeObjectURL = revoke; });
  const read = FileReader.prototype.readAsArrayBuffer;
  vi.spyOn(FileReader.prototype, "readAsArrayBuffer").mockImplementation(function (this: FileReader, file) {
    jobs.push(new Promise(resolve => this.addEventListener("loadend", () => resolve(), { once: true })));
    read.call(this, file);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const finishReads = () => act(async () => { await Promise.all(jobs); });

describe("Direct Hermes local preview safety", () => {
  it("rejects oversized files before reading or allocating an object URL", async () => {
    render(<DirectHermesAttachmentPreview attachment={attachment(new File([new Uint8Array(2 * 1024 * 1024 + 1)], "large.png", { type: "image/png" }))} />);
    await finishReads();
    expect(FileReader.prototype.readAsArrayBuffer).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
  it.each(["oversized dimensions", "zero dimension", "malformed signature", "truncated chunks", "animation"])("rejects %s before the browser decodes the image", async reason => {
    let bytes = png();
    const view = new DataView(bytes.buffer);
    if (reason === "oversized dimensions") view.setUint32(16, 100_000);
    if (reason === "zero dimension") view.setUint32(20, 0);
    if (reason === "malformed signature") bytes[0] = 0;
    if (reason === "truncated chunks") bytes = bytes.slice(0, 35);
    if (reason === "animation") view.setUint32(37, 0x6163544c);
    render(<DirectHermesAttachmentPreview attachment={attachment(new File([bytes], "unpreviewable.png", { type: "image/png" }))} />);
    await finishReads();
    expect(create).not.toHaveBeenCalled();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("Image preview unavailable")).toBeInTheDocument();
  });
  it("does not invent a preview for history metadata without client bytes or for unsupported image formats", async () => {
    const view = render(<DirectHermesAttachmentPreview attachment={attachment()} />);
    expect(screen.getByText("Image preview unavailable")).toBeInTheDocument();
    view.rerender(<DirectHermesAttachmentPreview attachment={attachment(new File(["<svg>"], "vector.svg", { type: "image/svg+xml" }))} />);
    await finishReads();
    expect(create).not.toHaveBeenCalled();
    expect(FileReader.prototype.readAsArrayBuffer).not.toHaveBeenCalled();
  });
  it("releases replaced previews and aborts unfinished reads on unmount", async () => {
    const first = new File([png()], "first.png", { type: "image/png" });
    const second = new File([png()], "second.png", { type: "image/png" });
    const view = render(<DirectHermesAttachmentPreview attachment={attachment(first)} />);
    await finishReads();
    expect(screen.getByRole("img")).toHaveAccessibleName("Local preview of first.png");
    view.rerender(<DirectHermesAttachmentPreview attachment={attachment(second)} />);
    expect(revoke).toHaveBeenCalledOnce();
    view.unmount();
    await finishReads();
    expect(create).toHaveBeenCalledTimes(1);
  });
});
