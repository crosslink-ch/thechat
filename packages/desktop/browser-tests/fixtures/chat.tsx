import { createRoot } from "react-dom/client";
import type { ChatMessage } from "@thechat/shared";
import { ChannelChatView } from "../../src/components/ChannelChatView";
import { HermesDmChatView } from "../../src/components/HermesDmChatView";
import "../../src/App.css";

// Real chat/composer components and CSS, with local synthetic history only.
// Fewer than 40 rows avoids the unrelated deferred-markdown loading path.
const messages: ChatMessage[] = Array.from({ length: 30 }, (_, index) => ({
  id: `message-${index}`,
  conversationId: "browser-test",
  threadId: null,
  senderId: `sender-${index % 2}`,
  senderName: index % 2 ? "Ada" : "Sam",
  senderType: "human",
  content: `Message ${index}: Some previous conversation history.`,
  createdAt: new Date(Date.UTC(2026, 0, 1, 9, index)).toISOString(),
}));
const props = {
  messages,
  loading: false,
  typingUsers: new Map<string, string>(),
  onSend: () => false,
  scrollKey: "browser-test",
};
const isHermes = new URLSearchParams(location.search).get("view") === "hermes";

createRoot(document.getElementById("root")!).render(
  <div className="flex h-screen min-h-0 flex-col bg-base">
    {isHermes ? (
      <HermesDmChatView
        {...props}
        progressInvocations={[]}
        typingSuppressedUserIds={[]}
      />
    ) : (
      <ChannelChatView {...props} />
    )}
  </div>,
);
