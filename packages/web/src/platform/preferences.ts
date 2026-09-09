

/** UI preferences only. Authentication never uses this adapter. */
export type PreferenceKey = "ui_font_size" | "active_workspace_id";
const memory = new Map<string, string>();
const storageKey = (key: PreferenceKey, account?: string) => `thechat:preferences:${account ?? "device"}:${key}`;
export const preferences = {
  async get(key: PreferenceKey, account?: string): Promise<string | null> {
    const id = storageKey(key, account);
    try { return localStorage.getItem(id) ?? memory.get(id) ?? null; }
    catch { return memory.get(id) ?? null; }
  },
  async set(key: PreferenceKey, value: string, account?: string): Promise<void> {
    const id = storageKey(key, account);
    memory.set(id, value);
    try { localStorage.setItem(id, value); } catch { /* denied/quota: session-only */ }
  },
  async delete(key: PreferenceKey, account?: string): Promise<void> {
    const id = storageKey(key, account);
    memory.delete(id);
    try { localStorage.removeItem(id); } catch { /* denied */ }
  },
};
