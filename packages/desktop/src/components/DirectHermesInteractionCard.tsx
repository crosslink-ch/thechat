import { useState } from "react";
import type { DirectHermesInteraction } from "../lib/direct-hermes-chat";

export function DirectHermesInteractionCard({ interaction, connected, respond }: {
  interaction: DirectHermesInteraction;
  connected: boolean;
  respond: (requestId: string, answer: string) => Promise<boolean>;
}) {
  const [answer, setAnswer] = useState("");
  const { type, payload, requestId } = interaction;
  const disabled = !connected || interaction.pending;
  const button = "cursor-pointer rounded border border-border bg-raised px-3 py-2 text-sm text-text-secondary hover:bg-hover disabled:opacity-50";
  const singleClarify = type === "clarify.request" && !Array.isArray(payload.questions) && !payload.multi_select;
  const choices = Array.isArray(payload.choices) ? payload.choices.filter((item): item is string => typeof item === "string") : [];
  return <div role="group" aria-label="Hermes needs your input" className="max-h-64 overflow-auto border-t border-border bg-surface p-4 text-sm text-text">
    <p className="mb-2 font-semibold">{type === "approval.request" ? "Approval required" : singleClarify ? "Hermes has a question" : "Interaction blocked"}</p>
    {interaction.error && <p role="alert" className="mb-2 text-error-bright">{interaction.error}</p>}
    {type === "approval.request" ? <>
      {typeof payload.description === "string" && <p className="mb-2">{payload.description}</p>}
      {typeof payload.command === "string" && <pre className="mb-3 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded border border-border p-2">{payload.command}</pre>}
      <div className="flex gap-2">{(!choices.length || choices.includes("once")) && <button type="button" className={button} disabled={disabled} onClick={() => void respond(requestId, "once")}>Allow once</button>}<button type="button" className={button} disabled={disabled} onClick={() => void respond(requestId, "deny")}>Deny</button></div>
    </> : singleClarify ? <form onSubmit={event => { event.preventDefault(); void respond(requestId, answer); }}>
      {typeof payload.question === "string" && <p className="mb-2 whitespace-pre-wrap">{payload.question}</p>}
      <div className="mb-2 flex flex-wrap gap-2">{choices.map(choice => <button key={choice} type="button" className={button} disabled={disabled} onClick={() => setAnswer(choice)}>{choice}</button>)}</div>
      <input aria-label="Answer" value={answer} disabled={disabled} onChange={event => setAnswer(event.target.value)} className="mb-2 w-full rounded border border-border bg-base p-2 text-text" />
      <div className="flex gap-2"><button type="submit" className={button} disabled={disabled || !answer.trim()}>Submit answer</button><button type="button" className={button} disabled={disabled} onClick={() => void respond(requestId, "")}>Skip question</button></div>
    </form> : <p>This interaction requires the Hermes app ({type}). Open Hermes to respond, or use Stop below. Do not enter passwords or secrets in the chat.</p>}
  </div>;
}
