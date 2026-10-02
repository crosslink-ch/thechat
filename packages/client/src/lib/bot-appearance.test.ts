import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  BOT_AVATAR_COLORS,
  BOT_AVATAR_SHAPES,
  defaultBotAppearance,
  resolveBotAppearance,
  type WorkspaceWithDetails,
} from "@thechat/shared";
import { useWorkspacesStore } from "../stores/workspaces";
import { useBotAppearance } from "./bot-appearance";

const botUserId = "11111111-2222-4333-8444-555555555555";

afterEach(() => {
  act(() => useWorkspacesStore.setState({ activeWorkspace: null }));
});

describe("bot appearance", () => {
  it("resolves an explicitly saved Minimal appearance", () => {
    expect(resolveBotAppearance(botUserId, {
      avatarShape: "minimal", avatarColor: "#00b894",
    })).toEqual({ shape: "minimal", color: "#00B894" });
  });
  it("preserves every legacy default shape and colour without opting into Minimal", () => {
    const legacyShapes = ["clover", "flower", "triangle", "square", "blob", "ghost",
      "circle", "drop", "star", "droid", "mech", "alien", "hexagon", "cat",
      "cloud", "pill", "pebble", "puddle"];
    for (const id of ["", botUserId, "🤖", ...Array.from({ length: 10_000 }, (_, i) => `bot-${i}`)]) {
      let hash = 0;
      for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
      const value = hash >>> 0;
      const expected = {
        shape: legacyShapes[value % 18],
        color: BOT_AVATAR_COLORS[Math.floor(value / 18) % 22],
      };
      expect(defaultBotAppearance(id)).toEqual(expected);
      expect(resolveBotAppearance(id, {})).toEqual(expected);
      expect(resolveBotAppearance(id, { avatarShape: "invalid" })).toEqual(expected);
    }
  });

  it("gives each bot a stable default from the palette", () => {
    const first = defaultBotAppearance(botUserId);
    expect(defaultBotAppearance(botUserId)).toEqual(first);
    expect(BOT_AVATAR_SHAPES).toContain(first.shape);
    expect(BOT_AVATAR_COLORS).toContain(first.color);
  });

  it("spreads defaults across the shapes", () => {
    const shapes = new Set(
      Array.from({ length: 200 }, (_, i) => defaultBotAppearance(`bot-${i}`).shape),
    );
    expect(shapes.size).toBeGreaterThan(12);
  });

  it("keeps saved picks and falls back per part", () => {
    const fallback = defaultBotAppearance(botUserId);
    expect(
      resolveBotAppearance(botUserId, { avatarShape: "cat", avatarColor: "#00b894" }),
    ).toEqual({ shape: "cat", color: "#00B894" });
    expect(
      resolveBotAppearance(botUserId, { avatarShape: "dragon", avatarColor: null }),
    ).toEqual(fallback);
  });

  it("reads a bot's appearance from the active workspace, else its default", () => {
    const { result } = renderHook(() => useBotAppearance(botUserId));
    expect(result.current).toEqual(defaultBotAppearance(botUserId));

    act(() => {
      useWorkspacesStore.setState({
        activeWorkspace: {
          id: "workspace-1",
          members: [
            {
              userId: botUserId,
              role: "member",
              joinedAt: "2026-01-01T00:00:00.000Z",
              user: { id: botUserId, name: "Koda", email: null, avatar: null, type: "bot" },
              bot: { id: "bot-1", kind: "hermes", avatar: { shape: "star", color: "#F39C12" } },
            },
          ],
        } as unknown as WorkspaceWithDetails,
      });
    });
    expect(result.current).toEqual({ shape: "star", color: "#F39C12" });
  });
});
