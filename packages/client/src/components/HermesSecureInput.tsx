import { useLayoutEffect, useRef, useState } from "react";
import { SECURE_INPUT_KINDS, type BotInvocationProgressEventPublic, type SecureInputResponse } from "@thechat/shared";
import { encryptSecureInput, secureInputContext, secureInputValuesValid, type SecureInputState } from "../lib/hermes-secure-input";
import { buttonClass, inputClass } from "./ui";
export type SecureInputCallback = (event: BotInvocationProgressEventPublic, response: SecureInputResponse) => void | Promise<void>;
type Props = { state: SecureInputState; onResponse?: SecureInputCallback };
/** A context change remounts the secret owner, invalidating even in-flight crypto. */
export function HermesSecureInput(props: Props) {
  return <SecureInputForm key={JSON.stringify([props.state.event.id, secureInputContext(props.state.event, props.state.request), props.state.request.publicKeySpkiB64])} {...props} />;
}
const labels = { identifier: "Username or email", password: "Password", code: "Verification or recovery code", value: "Secret value" };
function SecureInputForm({ state, onResponse }: Props) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [delivered, setDelivered] = useState<"submitted" | "cancelled" | null>(null);
  const [expired, setExpired] = useState(state.request.expiresAt <= Date.now());
  const [error, setError] = useState(false);
  const inputs = useRef(new Map<string, HTMLInputElement>());
  const active = useRef(true);
  const pending = useRef(false);
  const outcome = state.outcome ?? (expired ? "expired" : delivered);
  const clear = () => {
    inputs.current.forEach(input => { input.value = ""; });
    setValues({});
  };
  useLayoutEffect(() => {
    active.current = !outcome;
    const nodes = [...inputs.current.values()];
    if (outcome) clear();
    return () => { active.current = false; nodes.forEach(input => { input.value = ""; }); };
  }, [outcome]);
  useLayoutEffect(() => {
    const timer = window.setTimeout(() => { active.current = false; clear(); setExpired(true); }, Math.max(0, state.request.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [state.request.expiresAt]);
  const submit = async (action: "submit" | "cancel") => {
    if (pending.current || outcome || !active.current || !onResponse) return;
    pending.current = true;
    setBusy(true);
    setError(false);
    const local = { ...values };
    clear();
    try {
      const encrypted = action === "submit" ? encryptSecureInput(state.event, state.request, local) : Promise.resolve({ version: 3 as const, action: "cancel" as const });
      Object.keys(local).forEach(k => { local[k] = ""; });
      const response = await encrypted;
      if (!active.current || state.request.expiresAt <= Date.now()) return;
      await onResponse(state.event, response);
      if (active.current) setDelivered(action === "submit" ? "submitted" : "cancelled");
    } catch { if (active.current) setError(true); }
    finally {
      Object.keys(local).forEach(k => { local[k] = ""; });
      pending.current = false;
      if (active.current) setBusy(false);
    }
  };
  if (outcome) return <div data-testid="hermes-secure-input-resolved" className="px-1 py-1 text-text-dimmed">{outcome === "submitted" ? "Encrypted response delivered. The next tool result reports whether it succeeded." : `Secure input ${outcome}.`}</div>;
  const presentation = SECURE_INPUT_KINDS[state.request.promptKind];
  return <div data-testid="hermes-secure-input-request" className="hermes-interaction-card min-w-0 rounded-lg border border-l-3 border-border border-l-warning bg-elevated/60 px-4.5 py-4 text-text-secondary">
    <div className="font-medium text-text">{presentation.title}</div>
    <p className="mt-1 text-sm">{presentation.description}</p>
    <p className="mt-1 break-all text-sm">Target: {state.request.target}</p>
    <form className="mt-3 space-y-2" autoComplete="off" onSubmit={e => { e.preventDefault(); void submit("submit"); }}>
      {state.request.fields.map(field => <div key={field}>
        <label htmlFor={`secure-${state.event.id}-${field}`} className="block text-sm">{labels[field]}</label>
        <input ref={node => { if (node) inputs.current.set(field, node); else inputs.current.delete(field); }} id={`secure-${state.event.id}-${field}`} type={field === "identifier" ? "text" : "password"} value={values[field] ?? ""} autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false} disabled={busy || !onResponse} onChange={e => setValues(previous => ({ ...previous, [field]: e.target.value }))} className={`${inputClass} w-full`} />
      </div>)}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={buttonClass("primary", "sm")} disabled={busy || !onResponse || !secureInputValuesValid(state.request, values)}>Send securely</button>
        <button type="button" className={buttonClass("secondary", "sm")} disabled={busy || !onResponse} onClick={() => void submit("cancel")}>Cancel</button>
      </div>
    </form>
    {busy && <div role="status" className="mt-2 text-sm">Sending encrypted response…</div>}
    {error && <div role="alert" className="mt-2 text-sm text-error-bright">Could not deliver the secure input response. Try again.</div>}
  </div>;
}
