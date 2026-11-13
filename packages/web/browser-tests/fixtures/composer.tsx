import { useState } from "react";
import { createRoot } from "react-dom/client";
import { InputBar } from "@thechat/client/components/InputBar";
import { Markdown } from "@thechat/client/components/Markdown";
import { messageText, optimisticParts, type MessageInput } from "@thechat/client/lib/composer-parts";
import "@thechat/client/styles";

/** Synthetic composer page: the real InputBar and message renderer, no API. */
const MENTIONS = [
  { id: "aaaaaaaa-0000-4000-8000-000000000001", label: "Ada Lovelace", type: "human" as const },
  { id: "bbbbbbbb-0000-4000-8000-000000000002", label: "Koda", type: "bot" as const },
];

function ComposerFixture() {
  const [sent, setSent] = useState<MessageInput[]>([]);
  return (
    // Composer at the bottom, as in a chat view, so menus open above it.
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "0 12px", minHeight: "100vh", display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
      <section data-testid="sent-messages" style={{ display: "flex", flexDirection: "column", gap: 16, marginBottom: 16 }}>
        {sent.map((message, index) => {
          const { contentFormat, parts } = optimisticParts(message);
          return (
            <article key={index} data-testid="sent-message" style={{ padding: "8px 16px" }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Alice</div>
              <pre data-testid="sent-source" hidden>{messageText(message)}</pre>
              <Markdown content={messageText(message)} message={{ contentFormat, parts }} />
            </article>
          );
        })}
      </section>
      <InputBar
        convId={undefined}
        draftKey="composer-fixture"
        mentions={MENTIONS}
        onStop={() => {}}
        onSend={(message) => {
          setSent((previous) => [...previous, message]);
          return true;
        }}
      />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<ComposerFixture />);
