import { afterEach, describe, expect, it } from "vitest";
import {
  composerDraftKey,
  useComposerDraftsStore,
} from "./composer-drafts";

afterEach(() => {
  useComposerDraftsStore.setState({
    drafts: {},
    revisions: {},
    imageDrafts: {},
    attachmentDrafts: {},
    sendingAttachments: {},
  });
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

  it("keeps file drafts and send ownership isolated by composer scope", () => {
    const firstAttachment = {
      localId: "local-1",
      file: new File(["first"], "first.txt", { type: "text/plain" }),
      previewUrl: null,
      phase: "ready" as const,
      progress: 100,
      attachment: null,
      error: null,
    };
    const secondAttachment = {
      ...firstAttachment,
      localId: "local-2",
      file: new File(["second"], "second.txt", { type: "text/plain" }),
    };
    const store = useComposerDraftsStore.getState();
    store.setAttachmentDrafts("thread:one", [firstAttachment]);
    store.setAttachmentDrafts("thread:two", [secondAttachment]);
    store.setSendingAttachments("thread:one", true);

    expect(
      useComposerDraftsStore.getState().attachmentDrafts["thread:one"],
    ).toEqual([firstAttachment]);
    expect(
      useComposerDraftsStore.getState().attachmentDrafts["thread:two"],
    ).toEqual([secondAttachment]);
    expect(useComposerDraftsStore.getState().sendingAttachments).toEqual({
      "thread:one": true,
    });

    store.setAttachmentDrafts("thread:one", []);
    store.setSendingAttachments("thread:one", false);
    expect(useComposerDraftsStore.getState().attachmentDrafts).toEqual({
      "thread:two": [secondAttachment],
    });
    expect(useComposerDraftsStore.getState().sendingAttachments).toEqual({});
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
    const image = {
      id: "image-1",
      mimeType: "image/png",
      base64: "cG5n",
    };
    store.setImageDrafts(provisionalKey, [image]);

    store.moveDraft(provisionalKey, durableKey);

    expect(useComposerDraftsStore.getState().drafts).toEqual({
      [durableKey]: "next message typed during creation",
    });
    expect(useComposerDraftsStore.getState().imageDrafts).toEqual({
      [durableKey]: [image],
    });
  });
});
