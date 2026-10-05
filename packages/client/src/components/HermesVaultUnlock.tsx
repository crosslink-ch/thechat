import { useEffect, useRef, useState } from "react";
import type {
  BotInvocationProgressEventPublic,
  VaultUnlockResponse,
} from "@thechat/shared";
import {
  encryptVaultUnlock,
  type VaultUnlockState,
} from "../lib/hermes-vault-unlock";
import { buttonClass, inputClass } from "./ui";
export type VaultUnlockCallback = (
  event: BotInvocationProgressEventPublic,
  response: VaultUnlockResponse,
) => void | Promise<void>;

/** Password state belongs only to this mounted request, never a chat/store/query. */
export function HermesVaultUnlock({
  state,
  onResponse,
}: {
  state: VaultUnlockState;
  onResponse?: VaultUnlockCallback;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [delivered, setDelivered] = useState<"submitted" | "cancelled" | null>(
    null,
  );
  const [error, setError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const active = useRef(true);
  const pending = useRef(false);
  const outcome = state.outcome ?? delivered;
  const clear = () => {
    if (inputRef.current) inputRef.current.value = "";
    setPassword("");
  };
  useEffect(() => {
    active.current = !outcome;
    const input = inputRef.current;
    return () => {
      active.current = false;
      if (input) input.value = "";
    };
  }, [outcome]);
  useEffect(() => {
    if (outcome) clear();
  }, [outcome]);
  const submit = async (action: "submit" | "cancel") => {
    if (pending.current || outcome || !onResponse) return;
    pending.current = true;
    setBusy(true);
    setError(false);
    let secret = password;
    clear();
    try {
      const encrypted =
        action === "submit"
          ? encryptVaultUnlock(state.event, state.request, secret)
          : Promise.resolve({ version: 1 as const, action: "cancel" as const });
      secret = "";
      const response = await encrypted;
      if (!active.current || state.request.expiresAt <= Date.now()) return;
      await onResponse(state.event, response);
      if (active.current)
        setDelivered(action === "submit" ? "submitted" : "cancelled");
    } catch {
      if (active.current) setError(true);
    } finally {
      secret = "";
      pending.current = false;
      if (active.current) setBusy(false);
    }
  };
  if (outcome)
    return (
      <div
        data-testid="hermes-vault-unlock-resolved"
        className="px-1 py-1 text-text-dimmed"
      >
        {outcome === "submitted"
          ? "Encrypted response delivered. The next vault tool result reports whether unlock succeeded."
          : outcome === "cancelled"
            ? "Bitwarden unlock cancelled."
            : outcome === "expired"
              ? "Bitwarden unlock request expired."
              : "Bitwarden unlock failed."}
      </div>
    );
  return (
    <div
      data-testid="hermes-vault-unlock-request"
      className="hermes-interaction-card min-w-0 rounded-lg border border-l-3 border-border border-l-warning bg-elevated/60 px-4.5 py-4 text-text-secondary"
    >
      <div className="font-medium text-text">Unlock Bitwarden</div>
      <p className="mt-1 text-sm">
        Unlocking allows Hermes to access your owner vault for this runtime
        profile.
      </p>
      <form
        className="mt-3 space-y-2"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          void submit("submit");
        }}
      >
        <label
          htmlFor={`vault-password-${state.event.id}`}
          className="block text-sm"
        >
          Master password
        </label>
        <input
          ref={inputRef}
          id={`vault-password-${state.event.id}`}
          type="password"
          value={password}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          disabled={busy || !onResponse}
          onChange={(e) => setPassword(e.target.value)}
          className={`${inputClass} w-full`}
        />
        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            className={buttonClass("primary", "sm")}
            disabled={busy || !password.length || !onResponse}
          >
            Unlock
          </button>
          <button
            type="button"
            className={buttonClass("secondary", "sm")}
            disabled={busy || !onResponse}
            onClick={() => void submit("cancel")}
          >
            Cancel
          </button>
        </div>
      </form>
      {busy && (
        <div role="status" className="mt-2 text-sm">
          Sending encrypted response…
        </div>
      )}
      {error && (
        <div role="alert" className="mt-2 text-sm text-error-bright">
          Could not deliver the vault unlock response. Try again.
        </div>
      )}
    </div>
  );
}
