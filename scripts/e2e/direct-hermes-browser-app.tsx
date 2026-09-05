// Dedicated E2E entry only. Production component + real login/API/proxy.
// This file is not imported by the shipped desktop app and adds no auth bypass.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DirectHermesSessionsView } from '__DIRECT_HERMES_COMPONENT__';
import '__DIRECT_HERMES_CSS__';

declare const __BACKEND_URL__: string;
declare const __ACCEPTANCE_BOT__: {botId: string; botName: string; conversationId: string};
const client = new QueryClient();

function Harness() {
  const [token, setToken] = useState(sessionStorage.getItem('direct-hermes-e2e-token'));
  const [error, setError] = useState('');
  return <QueryClientProvider client={client}>
    <div style={{height: '100vh', display: 'flex', flexDirection: 'column'}}>
      <p style={{padding: 8, margin: 0, background: '#332800', color: '#ffe1a0'}}>
        Acceptance harness · real Hermes/API/proxy · deterministic inference fixture, NOT a paid LLM
      </p>
      {token ? <DirectHermesSessionsView {...__ACCEPTANCE_BOT__} token={token}/> :
        <form style={{padding: 24}} onSubmit={async event => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          try {
            const response = await fetch(__BACKEND_URL__ + '/auth/login', {
              method: 'POST', headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({email: form.get('email'), password: form.get('password')})
            });
            if (!response.ok) throw new Error('Real TheChat login rejected: ' + response.status);
            const data = await response.json();
            if (!data.accessToken) throw new Error('Login returned no access token');
            sessionStorage.setItem('direct-hermes-e2e-token', data.accessToken);
            setToken(data.accessToken);
          } catch (error) { setError(String(error)); }
        }}>
          <h1>Disposable acceptance login</h1>
          <label>Email <input type="email" name="email" required/></label><br/>
          <label>Password <input type="password" name="password" required/></label><br/>
          <button type="submit">Sign in to acceptance</button>
          {error && <p role="alert">{error}</p>}
        </form>}
    </div>
  </QueryClientProvider>;
}
createRoot(document.getElementById('root')!).render(<Harness/>);
