import { useEffect, useRef, useState } from "react";
import type { DirectHermesSettings } from "@thechat/shared";
import { api } from "../lib/api";

const inputClass = "min-w-0 rounded-lg border border-border bg-base px-3 py-2 text-sm text-text outline-none focus:border-border-focus disabled:opacity-50";
const buttonClass = "cursor-pointer rounded-lg border border-border-strong bg-elevated px-4 py-2 text-sm font-semibold text-text hover:not-disabled:bg-button disabled:cursor-not-allowed disabled:opacity-50";

function validEndpoint(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:", "ws:", "wss:"].includes(url.protocol) && !!url.hostname && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

type SettingsProps = { botId: string; token: string | null };

export function DirectHermesBotSettings(props: SettingsProps) {
  // A bot switch destroys the previous secret, draft and request state immediately.
  return <DirectHermesBotSettingsPanel key={props.botId} {...props} />;
}

function DirectHermesBotSettingsPanel({ botId, token }: SettingsProps) {
  const [settings, setSettings] = useState<DirectHermesSettings | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [gatewayToken, setGatewayToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [allowedUserIds, setAllowedUserIds] = useState<string[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [stale, setStale] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    generation.current++;
    let cancelled = false;
    setSettings(null);
    setGatewayToken("");
    setError(null);
    setStale(false);
    setAcknowledged(false);
    setSuccess(null);
    setSaving(false);
    if (!token) { setError("Sign in to manage Direct Hermes settings."); return; }
    void (async () => {
      try {
        const { data, error } = await api.bots({ botId })["hermes-rpc"].settings.get({ headers: { authorization: `Bearer ${token}` } });
        if (cancelled) return;
        if (error || !data || !("botId" in data) || data.botId !== botId) throw new Error("Could not load Direct Hermes settings.");
        setSettings(data);
        setEndpoint(data.endpoint);
        setAllowedUserIds(data.allowedUserIds);
        setError(null);
      } catch {
        if (!cancelled) setError("Could not load Direct Hermes settings.");
      }
    })();
    return () => { cancelled = true; generation.current++; };
  }, [botId, token, loadAttempt]);

  if (error && !settings) return <div className="space-y-3 rounded-xl border border-border p-4"><p role="alert" className="text-sm text-error-bright">{error}</p>{token && <button type="button" className={buttonClass} onClick={() => setLoadAttempt(attempt => attempt + 1)}>Retry loading settings</button>}</div>;
  if (!settings) return <p role="status" className="p-4 text-sm text-text-muted">Loading Direct Hermes settings…</p>;
  const grantsChanged = allowedUserIds.length !== settings.allowedUserIds.length || allowedUserIds.some(id => !settings.allowedUserIds.includes(id));
  const addsUsers = allowedUserIds.some(id => !settings.allowedUserIds.includes(id));
  const users = [...settings.eligibleUsers, ...settings.allowedUserIds
    .filter(id => !settings.eligibleUsers.some(user => user.id === id))
    .map(id => ({ id, name: `Unavailable user (${id})` }))];
  const hasReplacementToken = !!gatewayToken.trim();
  const endpointChanged = endpoint.trim() !== settings.endpoint;
  const endpointValid = validEndpoint(endpoint.trim());
  const needsToken = endpointChanged && !hasReplacementToken;
  const canSave = (grantsChanged || hasReplacementToken || endpointChanged) && endpointValid && !needsToken && (!addsUsers || acknowledged) && !saving && !stale;
  const save = async () => {
    if (!canSave || !token) return;
    const requestGeneration = generation.current;
    setSaving(true);
    setSuccess(null);
    setError(null);
    try {
      const { data, error } = await api.bots({ botId })["hermes-rpc"].settings.patch({
        revision: settings.revision,
        ...(endpointChanged ? { endpoint: endpoint.trim() } : {}),
        ...(grantsChanged ? { allowedUserIds } : {}),
        ...(hasReplacementToken ? { gatewayToken } : {}),
        ...(addsUsers ? { acknowledgeSharedAccess: true } : {}),
      }, { headers: { authorization: `Bearer ${token}` } });
      if (requestGeneration !== generation.current) return;
      // The server's dynamic status codes are wider than Treaty's inferred 422.
      if (Number(error?.status) === 409) {
        setStale(true);
        setGatewayToken("");
        setAcknowledged(false);
        setError("Settings changed elsewhere. Reload settings and review your changes before saving again.");
        return;
      }
      if (error || !data || !("botId" in data) || data.botId !== botId) throw new Error("Could not save Direct Hermes settings.");
      setSettings(data);
      setAllowedUserIds(data.allowedUserIds);
      setEndpoint(data.endpoint);
      setGatewayToken("");
      setAcknowledged(false);
      setSuccess("Direct Hermes settings saved. Reconnect to use the updated gateway and access settings. Running work may still continue in Hermes.");
    } catch {
      if (requestGeneration !== generation.current) return;
      setGatewayToken("");
      setAcknowledged(false);
      setError("Could not save Direct Hermes settings. Review the gateway and selected people, or reload settings.");
    } finally {
      if (requestGeneration === generation.current) setSaving(false);
    }
  };
  return <form onSubmit={event => { event.preventDefault(); void save(); }} className="space-y-4">
    {error && <div className="space-y-3 rounded-lg border border-error-msg-border bg-error-msg-bg p-3"><p role="alert" className="text-sm text-error-bright">{error}</p><button type="button" disabled={saving} className={buttonClass} onClick={() => setLoadAttempt(attempt => attempt + 1)}>Reload settings (discard draft)</button></div>}
    {success && <p role="status" className="rounded-lg border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-400">{success}</p>}
    <fieldset disabled={saving} className="min-w-0 space-y-4">
    <section className="rounded-xl border border-border bg-raised/40 p-4">
    <h3 className="text-sm font-semibold text-text">Direct Hermes gateway</h3>
    <div className="mt-4 grid gap-4">
      <label className="grid gap-1.5 text-sm text-text-muted">Gateway endpoint
        <input aria-label="Gateway endpoint" aria-invalid={!endpointValid} aria-describedby="hermes-endpoint-help" className={inputClass} value={endpoint} onChange={event => setEndpoint(event.target.value)} autoComplete="off" spellCheck={false} />
        <span id="hermes-endpoint-help" className={`text-xs ${endpointValid ? "text-text-dimmed" : "text-error-bright"}`}>Use an HTTP(S) or WS(S) gateway URL without credentials, query parameters, or a fragment. The server must allow this gateway origin.</span>
      </label>
      <p className="text-sm text-text-muted">{settings.gatewayTokenConfigured ? "Gateway token configured" : "Gateway token not configured"}</p>
      <label className="grid gap-1.5 text-sm text-text-muted">Replacement gateway token
        <input aria-label="Replacement gateway token" aria-invalid={needsToken} aria-describedby="hermes-token-help" type="password" className={inputClass} value={gatewayToken} onChange={event => setGatewayToken(event.target.value)} autoComplete="new-password" spellCheck={false} />
        <span className="text-xs text-text-dimmed">The stored token is never shown. Leave blank to keep it when the endpoint is unchanged.</span>
        {endpointChanged && <span id="hermes-token-help" className={`text-xs ${needsToken ? "text-error-bright" : "text-text-dimmed"}`}>Changing the endpoint requires a replacement gateway token.</span>}
      </label>
    </div>
    </section>
    <section className="rounded-xl border border-border bg-raised/40 p-4">
      <h3 className="text-sm font-semibold text-text">Who can talk to this bot</h3>
      <p className="mt-2 text-sm text-text-muted">{allowedUserIds.length ? "You (the owner) and the selected people." : "Only you (the owner). No one else has access by default."}</p>
      <div role="note" aria-label="Shared gateway access warning" className="my-4 rounded-lg border border-amber-400/40 bg-amber-400/10 p-3 text-sm text-amber-300">
        <p className="font-semibold">Sharing grants access to the same Hermes gateway and all its sessions and runtime controls.</p>
        <p className="mt-1">This is not isolated private-chat access. Selected people can see other sessions and control the shared runtime.</p>
      </div>
      <p className="mb-3 text-xs text-text-dimmed">Choose specific human users. Workspace membership alone never grants access; each person must connect through their own DM with this bot.</p>
      <div className="space-y-2">
        {!users.length && <p className="text-sm text-text-dimmed">No eligible people. Connect the bot to a workspace with other human members, then reopen these settings.</p>}
        {users.map(user => <label key={user.id} className="flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-base p-3 text-sm text-text-muted">
          <input type="checkbox" aria-label={user.name} checked={allowedUserIds.includes(user.id)} onChange={event => { setAllowedUserIds(ids => event.target.checked ? [...ids, user.id] : ids.filter(id => id !== user.id)); setAcknowledged(false); }} className="size-4 shrink-0 accent-accent" />
          <span className="min-w-0 break-words">{user.name}</span>
        </label>)}
      </div>
      <label className="mt-4 flex cursor-pointer items-start gap-2 text-sm text-text-muted">
        <input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} className="mt-0.5 size-4 shrink-0 accent-accent" />
        <span>I understand that sharing gives selected people access to all sessions and runtime controls on this Hermes gateway.</span>
      </label>
    </section>
    <button type="submit" disabled={!canSave} className={buttonClass}>{saving ? "Saving Direct Hermes settings…" : "Save Direct Hermes settings"}</button>
    </fieldset>
  </form>;
}
