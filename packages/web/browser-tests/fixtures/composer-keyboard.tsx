import { useState } from "react";
import { createRoot } from "react-dom/client";
import { InputBar } from "@thechat/client/components/InputBar";
import { useComposerDraftsStore } from "@thechat/client/stores/composer-drafts";
import "@thechat/client/styles";

function ComposerKeyboardFixture() {
  const [sent, setSent] = useState<string[]>([]);
  const draft = useComposerDraftsStore((state) => state.drafts["keyboard-regression"] ?? "");
  return (
    <main style={{ maxWidth: 900, margin: "24px auto", padding: 16 }}>
      <h1>Composer keyboard regression</h1>
      <p>Synthetic local capture using the real InputBar. No API or message delivery.</p>
      <InputBar
        convId={undefined}
        draftKey="keyboard-regression"
        onStop={() => {}}
        onSend={(content) => { setSent((previous) => [...previous, content]); return true; }}
      />
      <h2>Current draft</h2>
      <pre data-testid="draft" style={{ whiteSpace: "pre-wrap" }}>{draft}</pre>
      <h2>Sent messages</h2>
      {sent.map((content, index) => <pre key={index} data-testid="sent-source" style={{ whiteSpace: "pre-wrap" }}>{content}</pre>)}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<ComposerKeyboardFixture />);
