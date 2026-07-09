import { describe, expect, test } from "bun:test";
import {
  createChatMessageSentV1,
  MAX_BOT_AUTOMATION_DEPTH,
} from "./envelope";
import { createChatMessageSentHandler } from "./message-handler";
import { PermanentDomainEventError } from "./registry";

const ids = {
  message: "11111111-1111-4111-8111-111111111111",
  conversation: "22222222-2222-4222-8222-222222222222",
  sender: "33333333-3333-4333-8333-333333333333",
  bot: "44444444-4444-4444-8444-444444444444",
};

describe("chat.message.sent automation guards", () => {
  test("suppresses bot-authored events at the configured causal-depth limit", async () => {
    const event = createChatMessageSentV1({
      messageId: ids.message,
      conversationId: ids.conversation,
      targetBotIds: [ids.bot],
      messageKind: "bot_response",
      automationDepth: MAX_BOT_AUTOMATION_DEPTH,
      senderId: ids.sender,
      senderType: "bot",
    });

    await expect(createChatMessageSentHandler().handle(event)).resolves.toBeUndefined();
  });

  test("classifies a missing canonical message as a permanent poison event", async () => {
    await expect(
      createChatMessageSentHandler().handle(
        createChatMessageSentV1({
          messageId: ids.message,
          conversationId: ids.conversation,
          targetBotIds: [],
          messageKind: "user",
          automationDepth: 0,
          senderId: ids.sender,
          senderType: "human",
        }),
      ),
    ).rejects.toBeInstanceOf(PermanentDomainEventError);
  });

  test("never turns a system failure message into another bot invocation", async () => {
    const event = createChatMessageSentV1({
      messageId: ids.message,
      conversationId: ids.conversation,
      targetBotIds: [],
      messageKind: "system_failure",
      automationDepth: 1,
      senderId: ids.sender,
      senderType: "bot",
    });

    await expect(createChatMessageSentHandler().handle(event)).resolves.toBeUndefined();
  });
});
