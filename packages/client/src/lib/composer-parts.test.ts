import { describe, expect, it } from "vitest";
import { getSchema } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Mention from "@tiptap/extension-mention";
import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { projectPartsContent, type InputChatPart } from "@thechat/shared";
import {
  composerFromStoredParts,
  composerToDocument,
  messageInputSignature,
  messageRequestBody,
  serializeComposer,
  type ComposerDocument,
} from "./composer-parts";

const schema = getSchema([
  StarterKit.configure({ link: { autolink: false, linkOnPaste: false } }),
  Mention,
]);

const ADA = "11111111-1111-4111-8111-111111111111";
const KODA = "22222222-2222-4222-8222-222222222222";

function round(document: ComposerDocument) {
  return serializeComposer(ProseMirrorNode.fromJSON(schema, composerToDocument(document)));
}

describe("composer serializer (Tiptap <-> parts-v1)", () => {
  it("emits the picked user's ID and projects the same text the editor showed", () => {
    const doc = ProseMirrorNode.fromJSON(schema, {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Hi " },
            { type: "mention", attrs: { id: KODA, label: "Koda" } },
            { type: "text", text: ", please ask " },
            { type: "mention", attrs: { id: ADA, label: "Ada Lovelace" } },
          ],
        },
        { type: "paragraph", content: [{ type: "text", text: "  - indented line" }] },
        { type: "paragraph" },
        { type: "paragraph", content: [{ type: "text", text: "after a blank line" }] },
      ],
    });

    const result = serializeComposer(doc);

    expect(result.parts).toEqual<InputChatPart[]>([
      { type: "text", text: "Hi " },
      { type: "reference", refType: "user", refId: KODA },
      { type: "text", text: ", please ask " },
      { type: "reference", refType: "user", refId: ADA },
      { type: "text", text: "\n  - indented line\n\nafter a blank line" },
    ]);
    expect(result.labels).toEqual({ [KODA]: "Koda", [ADA]: "Ada Lovelace" });
    expect(result.text).toBe("Hi @Koda, please ask @Ada Lovelace\n  - indented line\n\nafter a blank line");
    // The server derives `content` with the same projector.
    expect(projectPartsContent(result.parts, (id) => result.labels[id])).toBe(result.text);
  });

  it("keeps a typed @Name as text: only a picked mention carries an ID", () => {
    const doc = ProseMirrorNode.fromJSON(schema, {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Hey @Koda, typed by hand" }] }],
    });
    expect(serializeComposer(doc).parts).toEqual([{ type: "text", text: "Hey @Koda, typed by hand" }]);
  });

  it("round-trips Unicode, emoji, right-to-left text and Markdown around references", () => {
    const original: ComposerDocument = {
      text: "",
      labels: { [ADA]: "Zoë 🧪", [KODA]: "كودا" },
      parts: [
        { type: "text", text: "**bold** " },
        { type: "reference", refType: "user", refId: ADA },
        { type: "text", text: " 👋🏽 e\u0301 — مرحبا " },
        { type: "reference", refType: "user", refId: KODA },
        { type: "text", text: "\n`code` _end_" },
      ],
    };
    const result = round(original);
    expect(result.parts).toEqual(original.parts);
    expect(result.text).toBe("**bold** @Zoë 🧪 👋🏽 e\u0301 — مرحبا @كودا\n`code` _end_");
  });

  it("restores a draft with its mentions, preferring the current name", () => {
    const draft: ComposerDocument = {
      text: "@Old name hi",
      labels: { [ADA]: "Old name" },
      parts: [
        { type: "reference", refType: "user", refId: ADA },
        { type: "text", text: " hi" },
      ],
    };
    const doc = composerToDocument(draft, (id) => (id === ADA ? "New name" : undefined));
    expect(doc.content?.[0]?.content?.[0]).toEqual({
      type: "mention",
      attrs: { id: ADA, label: "New name" },
    });
    expect(round(draft).parts).toEqual(draft.parts);
  });

  it("restores the same mention twice as two nodes", () => {
    const twice: ComposerDocument = {
      text: "",
      labels: { [KODA]: "Koda" },
      parts: [
        { type: "reference", refType: "user", refId: KODA },
        { type: "text", text: " and again " },
        { type: "reference", refType: "user", refId: KODA },
      ],
    };
    expect(round(twice).parts).toEqual(twice.parts);
  });

  it("rebuilds an editable document from a sent message's stored parts", () => {
    const composer = composerFromStoredParts([
      { type: "text", text: "Hi " },
      { type: "reference", refType: "user", refId: KODA, label: "Koda", targetType: "bot" },
    ]);
    expect(composer).toEqual({
      text: "Hi @Koda",
      labels: { [KODA]: "Koda" },
      parts: [
        { type: "text", text: "Hi " },
        { type: "reference", refType: "user", refId: KODA },
      ],
    });
  });

  it("sends composer output as parts-v1 and plain strings as legacy content", () => {
    const composer = composerFromStoredParts([
      { type: "reference", refType: "user", refId: KODA, label: "Koda" },
    ]);
    expect(messageRequestBody(composer)).toEqual({
      contentFormat: "parts-v1",
      parts: [{ type: "reference", refType: "user", refId: KODA }],
    });
    expect(messageRequestBody("/help")).toEqual({ content: "/help" });
  });

  it("tells sends apart by target ID, not by visible name", () => {
    const toAda = composerFromStoredParts([
      { type: "reference", refType: "user", refId: ADA, label: "Sam" },
    ]);
    const toKoda = composerFromStoredParts([
      { type: "reference", refType: "user", refId: KODA, label: "Sam" },
    ]);
    expect(toAda.text).toBe(toKoda.text);
    expect(messageInputSignature(toAda)).not.toBe(messageInputSignature(toKoda));
    expect(messageInputSignature(toAda)).toBe(messageInputSignature({ ...toAda, labels: {} }));
  });
});
