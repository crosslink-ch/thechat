import { describe, expect, it } from "vitest";
import type { WorkspaceChannel, WorkspaceMember } from "@thechat/shared";
import { channelAccess, channelIncludes, channelMemberCount } from "./channel-access";

const member = (userId: string, role: WorkspaceMember["role"]): WorkspaceMember => ({
  userId, role, joinedAt: "2026-01-01",
  user: { id: userId, name: userId, email: null, avatar: null, type: "human" },
});
const workspace = [member("owner", "owner"), member("admin", "admin"), member("ann", "member"), member("ben", "member")];
const channel = (overrides: Partial<WorkspaceChannel>): WorkspaceChannel => ({
  id: "c", workspaceId: "w", name: "c", title: "C", isPrivate: false,
  createdAt: "2026-01-01", updatedAt: "2026-01-01", ...overrides,
});
const open = channel({});
const closed = channel({
  isPrivate: true,
  members: [{ userId: "ann", role: "admin" }, { userId: "ben", role: "member" }, { userId: "admin", role: "member" }],
});

describe("channelAccess", () => {
  it("leaves public channels to workspace owners and admins", () => {
    expect(channelAccess(open, workspace, "owner").canManage).toBe(true);
    expect(channelAccess(open, workspace, "admin").canManage).toBe(true);
    expect(channelAccess(open, workspace, "ann")).toEqual({
      isMember: true, isChannelAdmin: false, canManage: false, canAddMembers: false, canLeave: false,
    });
  });

  it("gives a private channel to its own admins, whatever their workspace role", () => {
    expect(channelAccess(closed, workspace, "ann")).toEqual({
      isMember: true, isChannelAdmin: true, canManage: true, canAddMembers: true, canLeave: true,
    });
    // An ordinary member can add people and leave, nothing more.
    expect(channelAccess(closed, workspace, "ben")).toEqual({
      isMember: true, isChannelAdmin: false, canManage: false, canAddMembers: true, canLeave: true,
    });
    // A workspace admin who is in the channel manages it without being its admin.
    expect(channelAccess(closed, workspace, "admin")).toMatchObject({ isChannelAdmin: false, canManage: true });
  });

  it("gives the workspace owner nothing in a private channel they are not in", () => {
    expect(channelAccess(closed, workspace, "owner")).toEqual({
      isMember: false, isChannelAdmin: false, canManage: false, canAddMembers: false, canLeave: false,
    });
    expect(channelAccess(closed, workspace, "stranger").isMember).toBe(false);
    expect(channelAccess(null, workspace, "ann").isMember).toBe(false);
  });
});

it("counts and reaches only the members of a private channel", () => {
  expect(channelMemberCount(open, workspace)).toBe(4);
  expect(channelMemberCount(closed, workspace)).toBe(3);
  expect(channelIncludes(open, "owner")).toBe(true);
  expect(channelIncludes(closed, "owner")).toBe(false);
  expect(channelIncludes(closed, "ben")).toBe(true);
  expect(channelIncludes(undefined, "ben")).toBe(true);
});
