// Test-only browser latency probe. The native WebSocket performs the complete
// real handshake and network exchange. Only delivery of one genuine session.list
// result is held; its bytes are never changed, replaced, or manufactured.
(() => {
  const NativeWebSocket = window.WebSocket;
  const delivered = new WeakSet();
  const probe = {arm: false, held: false, received: 0, released: 0, release: () => {}};
  window.__directHermesRefreshProbe = probe;
  window.WebSocket = class extends NativeWebSocket {
    constructor(...args) {
      super(...args);
      this.delayedIds = new Set();
      super.addEventListener('message', event => {
        if (delivered.has(event)) return;
        let frame;
        try { frame = JSON.parse(event.data); } catch { return; }
        if (!this.delayedIds.delete(frame.id)) return;
        if (!frame.result || !Array.isArray(frame.result.sessions)) throw new Error('Latency probe expected a REAL session.list result');
        event.stopImmediatePropagation();
        probe.received++;
        probe.held = true;
        let released = false;
        let timer;
        const release = () => {
          if (released) return;
          released = true;
          clearTimeout(timer);
          probe.held = false;
          probe.released++;
          // A stopped native event retains propagation state on redispatch.
          // Use a fresh envelope with the EXACT received bytes, never fake RPC.
          const releasedEvent = new MessageEvent('message', {data: event.data, origin: event.origin});
          delivered.add(releasedEvent);
          this.dispatchEvent(releasedEvent);
        };
        probe.release = release;
        timer = setTimeout(release, 8000); // finite safety release if an assertion fails
      }, true);
    }
    send(data) {
      if (probe.arm && typeof data === 'string') {
        let frame;
        try { frame = JSON.parse(data); } catch {}
        if (frame?.method === 'session.list') {
          this.delayedIds.add(frame.id);
          probe.arm = false;
        }
      }
      return super.send(data);
    }
  };
})();
