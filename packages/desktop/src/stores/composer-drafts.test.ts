import { afterEach, describe, expect, it } from "vitest";
import {
  composerDraftKey,
  useComposerDraftsStore,
} from "./composer-drafts";

afterEach(() => {
  useComposerDraftsStore.setState({ drafts: {}, revisions: {} });
});

describe("composer draft state", () => {
  it("builds distinct account, surface, and Hermes thread scopes", () => {
    const keys = [
      composerDraftKey.agent("conversation-1"),
      composerDraftKey.channel("user-1", "conversation-1"),
      composerDraftKey.channel("user-2", "conversation-1"),
      composerDraftKey.dm("user-1", "conversation-1"),
      composerDraftKey.dm("user-1", "conversation-1", "task-1"),
      composerDraftKey.dm("user-1", "conversation-1", "task-2"),
      composerDraftKey.dm("user-2", "conversation-1", "task-1"),
    ];

    expect(new Set(keys).size).toBe(keys.length);
  });

  it("retains non-empty drafts and removes empty ones", () => {
    const store = useComposerDraftsStore.getState();
    store.setDraft("thread:one", "first draft");
    store.setDraft("thread:two", "second draft");
    store.setDraft("thread:one", "");

    expect(useComposerDraftsStore.getState().drafts).toEqual({
      "thread:two": "second draft",
    });
  });

  it("restores submitted text only while the expected revision is current", () => {
    const store = useComposerDraftsStore.getState();
    store.setDraft("thread:one", "submitted text");
    store.setDraft("thread:one", "");
    const submittedClearRevision =
      useComposerDraftsStore.getState().revisions["thread:one"];

    expect(
      store.restoreDraft(
        "thread:one",
        submittedClearRevision,
        "submitted text",
      ),
    ).toBe(true);
    expect(useComposerDraftsStore.getState().drafts["thread:one"]).toBe(
      "submitted text",
    );

    store.setDraft("thread:one", "newer text");
    expect(
      store.restoreDraft(
        "thread:one",
        submittedClearRevision,
        "submitted text",
      ),
    ).toBe(false);
    expect(useComposerDraftsStore.getState().drafts["thread:one"]).toBe(
      "newer text",
    );
  });

  it("moves a provisional agent draft to its durable conversation scope", () => {
    const store = useComposerDraftsStore.getState();
    const provisionalKey = composerDraftKey.agent(undefined);
    const durableKey = composerDraftKey.agent("conversation-created");
    store.setDraft(provisionalKey, "next message typed during creation");

    store.moveDraft(provisionalKey, durableKey);

    expect(useComposerDraftsStore.getState().drafts).toEqual({
      [durableKey]: "next message typed during creation",
    });
  });
});
