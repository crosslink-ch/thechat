// Dedicated E2E entry only. Actual production routes/stores + real Eden login/API.
// No server auth bypass. Only native KV storage is bridged to browser sessionStorage.
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { DirectHermesSessionsView } from '__DIRECT_HERMES_COMPONENT__';
import { BotsManageRoute } from '__DIRECT_HERMES_DESKTOP__/routes/bots-manage';
import { api } from '__DIRECT_HERMES_DESKTOP__/lib/api';
import { queryClient } from '__DIRECT_HERMES_DESKTOP__/lib/query-client';
import { useAuthStore } from '__DIRECT_HERMES_DESKTOP__/stores/auth';
import { useWorkspacesStore } from '__DIRECT_HERMES_DESKTOP__/stores/workspaces';
import '__DIRECT_HERMES_CSS__';

declare const __ACCEPTANCE_BOT__: {botId: string; botName: string; botUserId: string; workspaceId: string};
// These are the sole Tauri commands used by auth/workspace persistence. Unexpected
// native calls fail rather than silently mock any application or server behavior.
Object.assign(window, {__TAURI_INTERNALS__: {invoke: async (command: string, args: {key: string; value?: string}) => {
  const key = 'direct-hermes-e2e-kv:' + args.key;
  if (command === 'kv_get') return sessionStorage.getItem(key);
  if (command === 'kv_set') { sessionStorage.setItem(key, args.value!); return; }
  if (command === 'kv_delete') { sessionStorage.removeItem(key); return; }
  throw new Error('Unexpected native command in acceptance: ' + command);
}}});

function Harness() {
  const {token, loading, login, initialize} = useAuthStore();
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [conversationId, setConversationId] = useState('');
  const [tab, setTab] = useState<'chat' | 'manage'>('chat');
  useEffect(() => { void initialize(); }, [initialize]);
  useEffect(() => {
    if (!token) { setReady(false); return; }
    let cancelled = false;
    void (async () => {
      try {
        await useWorkspacesStore.getState().initialize();
        await useWorkspacesStore.getState().selectWorkspace(__ACCEPTANCE_BOT__.workspaceId);
        if (!useWorkspacesStore.getState().activeWorkspace) throw new Error('Actual workspace API did not authorize this user');
        const response = await api.conversations.dm.post({workspaceId: __ACCEPTANCE_BOT__.workspaceId,
          otherUserId: __ACCEPTANCE_BOT__.botUserId}, {headers: {authorization: `Bearer ${token}`}});
        if (response.error || !response.data || !('id' in response.data)) throw new Error('Actual own-DM API failed');
        if (!cancelled) { setConversationId(response.data.id); setReady(true); }
      } catch (error) { if (!cancelled) setError(String(error)); }
    })();
    return () => { cancelled = true; };
  }, [token]);
  return <QueryClientProvider client={queryClient}>
    <div style={{height: '100vh', display: 'flex', flexDirection: 'column', minWidth: 0}}>
      <p style={{padding: 8, margin: 0, background: '#332800', color: '#ffe1a0'}}>
        Acceptance harness · real Hermes/API/proxy · deterministic inference fixture, NOT a paid LLM
      </p>
      {error && <p role="alert">{error}</p>}
      {ready && token ? <>
        <nav aria-label="Acceptance surfaces" className="flex shrink-0 gap-4 border-b border-border p-2 text-text">
          <button onClick={() => setTab('chat')} aria-pressed={tab === 'chat'}>Direct Hermes chat</button>
          <button onClick={() => setTab('manage')} aria-pressed={tab === 'manage'}>Manage bots</button>
        </nav>
        {tab === 'chat' ? <DirectHermesSessionsView botId={__ACCEPTANCE_BOT__.botId} botName={__ACCEPTANCE_BOT__.botName} conversationId={conversationId} token={token}/> :
          <div style={{flex: 1, minHeight: 0, minWidth: 0}}><BotsManageRoute/></div>}
      </> : loading || token ? <p role="status">Loading authenticated workspace…</p> :
        <form style={{padding: 24}} onSubmit={async event => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          try {
            setError('');
            await login(String(form.get('email')), String(form.get('password')));
          } catch (error) { setError(String(error)); }
        }}>
          <h1>Disposable acceptance login</h1>
          <label>Email <input type="email" name="email" required/></label><br/>
          <label>Password <input type="password" name="password" required/></label><br/>
          <button type="submit">Sign in to acceptance</button>
        </form>}
    </div>
  </QueryClientProvider>;
}
createRoot(document.getElementById('root')!).render(<Harness/>);
