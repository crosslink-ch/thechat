import { useState } from "react";
import { createRoot } from "react-dom/client";
import { InputBar } from "@thechat/client/components/InputBar";
import { Markdown } from "@thechat/client/components/Markdown";
import { useComposerDraftsStore } from "@thechat/client/stores/composer-drafts";
import "@thechat/client/styles";

const label = "KGSP 18-140 I V.mp4";
const href = "https://example.com/?file=KGSP%2018-140%20I%20V.mp4&e=Demo123&download=1#preview";

function LinkPasteFixture() {
  const [scope, setScope] = useState("A");
  const [sent, setSent] = useState<string[]>([]);
  const draft = useComposerDraftsStore((state) => state.drafts[`link-paste:${scope}`] ?? "");
  return (
    <main style={{ maxWidth: 900, margin: "32px auto", padding: 24 }}>
      <h1>Named link paste regression</h1>
      <p>Synthetic sample only: not a real video. Real InputBar and Markdown, local onSend capture; no account, API, bot or network message delivery.</p>
      <p>Select the following link text, Ctrl+C (Cmd+C on macOS), then click Message and Ctrl+V. Do not use Copy link address or copy a code block.</p>
      <p><a data-testid="copy-source" href={href} onClick={(event) => event.preventDefault()}>{label}</a></p>
      <p>Expected destination (compare the full href, including query and fragment):</p>
      <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{href}</pre>
      <p>Plain URL control (select and copy this text):</p>
      <p data-testid="plain-source" style={{ overflowWrap: "anywhere" }}>{href}</p>
      <nav aria-label="Drafts" style={{ display: "flex", gap: 24, margin: "20px 0" }}>
        {["A", "B"].map((key) => <button key={key} type="button" aria-pressed={scope === key} onClick={() => setScope(key)}>Draft {key}</button>)}
      </nav>
      <p>Active draft: {scope}. Switch away and back before sending to test string restoration (raw Markdown is expected).</p>
      <InputBar convId={undefined} draftKey={`link-paste:${scope}`} onStop={() => {}} onSend={(content) => { setSent((previous) => [...previous, content]); return true; }} />
      <h2>Current serialized draft</h2>
      <pre data-testid="draft" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{draft}</pre>
      <h2>Local sends</h2>
      {sent.map((content, index) => (
        <section key={index} data-testid="sent-message" style={{ marginTop: 24 }}>
          <h3>Send {index + 1}: captured onSend string</h3>
          <pre data-testid="sent-source" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{content}</pre>
          <div data-testid="rendered-message"><Markdown content={content} /></div>
        </section>
      ))}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<LinkPasteFixture />);
