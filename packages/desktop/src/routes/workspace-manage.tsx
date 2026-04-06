import { useState, useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { WorkspaceConfig, WorkspaceProvider, ReasoningEffort } from "@thechat/shared";
import { CODEX_MODELS } from "../core/models";
import { useAuthStore } from "../stores/auth";
import { useWorkspacesStore } from "../stores/workspaces";
import { api } from "../lib/api";

// ---------------------------------------------------------------------------
// Model Combobox (reused from settings pattern)
// ---------------------------------------------------------------------------

function ModelCombobox({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { id: string; name: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [activeIdx, setActiveIdx] = useState(0);

  const filtered = options.filter((o) => {
    const q = query.toLowerCase();
    return o.id.toLowerCase().includes(q) || o.name.toLowerCase().includes(q);
  });

  const displayValue = open
    ? query
    : options.find((o) => o.id === value)?.name ?? value;

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    setActiveIdx(0);
  }, [query]);

  useEffect(() => {
    if (!open || !listRef.current) return;
    const item = listRef.current.children[activeIdx] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [activeIdx, open]);

  const select = (id: string) => {
    onChange(id);
    setQuery("");
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <input
        ref={inputRef}
        type="text"
        value={displayValue}
        onFocus={() => {
          setOpen(true);
          setQuery("");
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          if (!open) setOpen(true);
        }}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActiveIdx((i) => Math.min(i + 1, filtered.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActiveIdx((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (filtered[activeIdx]) select(filtered[activeIdx].id);
          } else if (e.key === "Escape") {
            setOpen(false);
            setQuery("");
            inputRef.current?.blur();
          }
        }}
        placeholder="Search models..."
        className="w-full rounded-lg border border-border bg-raised px-3 py-2 text-[0.929rem] text-text outline-none transition-colors placeholder:text-text-dimmed focus:border-accent"
        spellCheck={false}
      />
      {open && filtered.length > 0 && (
        <ul
          ref={listRef}
          className="absolute z-50 mt-1 max-h-[200px] w-full overflow-y-auto rounded-lg border border-border bg-raised shadow-lg"
        >
          {filtered.map((o, i) => (
            <li
              key={o.id}
              onMouseDown={(e) => {
                e.preventDefault();
                select(o.id);
              }}
              onMouseEnter={() => setActiveIdx(i)}
              className={`cursor-pointer px-3 py-2 text-[0.929rem] ${
                i === activeIdx ? "bg-accent/15 text-accent" : "text-text hover:bg-hover"
              }`}
            >
              <span className="font-medium">{o.name}</span>
              <span className="ml-2 text-text-dimmed">{o.id}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVIDER_LABELS: Record<WorkspaceProvider, string> = {
  openrouter: "OpenRouter",
  codex: "Codex",
};

const REASONING_EFFORTS: { value: ReasoningEffort; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Max" },
];

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

function auth(token: string) {
  return { headers: { authorization: `Bearer ${token}` } };
}

export function WorkspaceManageRoute() {
  const navigate = useNavigate();
  const token = useAuthStore((s) => s.token);
  const activeWorkspace = useWorkspacesStore((s) => s.activeWorkspace);

  const [, setConfig] = useState<WorkspaceConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [provider, setProvider] = useState<WorkspaceProvider>("openrouter");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [openrouterModel, setOpenrouterModel] = useState("openai/gpt-4.1");
  const [codexModel, setCodexModel] = useState("gpt-5.4");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("xhigh");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Load config
  useEffect(() => {
    if (!token || !activeWorkspace) {
      setLoading(false);
      return;
    }

    (async () => {
      try {
        const { data, error } = await api.workspaces({ id: activeWorkspace.id }).config.get(auth(token));
        if (error) throw new Error((error as any).error || "Failed to load config");
        const cfg = data as WorkspaceConfig;
        setConfig(cfg);
        if (cfg.provider) setProvider(cfg.provider);
        if (cfg.openrouter) setApiKey(cfg.openrouter.apiKey);
        if (cfg.openrouterModel) setOpenrouterModel(cfg.openrouterModel);
        if (cfg.codexModel) setCodexModel(cfg.codexModel);
        if (cfg.reasoningEffort) setReasoningEffort(cfg.reasoningEffort);
      } catch {
        // Config doesn't exist yet, use defaults
      } finally {
        setLoading(false);
      }
    })();
  }, [token, activeWorkspace]);

  if (!activeWorkspace) {
    return (
      <div className="mx-auto h-full max-w-[600px] overflow-y-auto p-6">
        <p className="text-[0.929rem] text-text-muted">
          No workspace selected.{" "}
          <button
            type="button"
            className="cursor-pointer text-accent underline"
            onClick={() => navigate({ to: "/chat" })}
          >
            Go back
          </button>
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="mx-auto h-full max-w-[600px] overflow-y-auto p-6">
        <div className="text-[0.929rem] text-text-muted">Loading...</div>
      </div>
    );
  }

  const handleSave = async () => {
    if (!token) return;
    setSaving(true);
    setStatus("idle");
    setErrorMsg(null);

    try {
      // Save OpenRouter API key if present
      if (apiKey.trim()) {
        const { error } = await api.workspaces({ id: activeWorkspace.id }).config.openrouter.put(
          { apiKey: apiKey.trim() },
          auth(token),
        );
        if (error) throw new Error((error as any).error || "Failed to save OpenRouter config");
      }

      // Save model + reasoning settings
      const { error } = await api.workspaces({ id: activeWorkspace.id }).config.settings.put(
        {
          openrouterModel: openrouterModel || null,
          codexModel: codexModel || null,
          reasoningEffort,
        },
        auth(token),
      );
      if (error) throw new Error((error as any).error || "Failed to save settings");

      // Set active provider
      const { error: provErr } = await api.workspaces({ id: activeWorkspace.id }).config.provider.put(
        { provider },
        auth(token),
      );
      // Provider switch may fail if credentials aren't set yet - that's OK
      if (provErr) {
        const msg = (provErr as any).error || "";
        // Only show error if it's not about missing credentials
        if (!msg.includes("not configured") && !msg.includes("not connected") && !msg.includes("No configuration")) {
          throw new Error(msg);
        }
      }

      setStatus("saved");
    } catch (e) {
      setStatus("error");
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const currentRole = activeWorkspace.members.find(
    (m) => m.userId === useAuthStore.getState().user?.id,
  )?.role;
  const isAdmin = currentRole === "owner" || currentRole === "admin";

  return (
    <div className="mx-auto h-full max-w-[600px] overflow-y-auto p-6">
      <div className="mb-6 flex items-center gap-3">
        <button
          type="button"
          className="cursor-pointer rounded-lg border border-border bg-raised px-2.5 py-1.5 text-[0.857rem] text-text-muted transition-colors hover:bg-hover hover:text-text"
          onClick={() => navigate({ to: "/chat" })}
        >
          Back
        </button>
        <h2 className="text-[1.214rem] font-semibold tracking-tight text-text">
          {activeWorkspace.name}
        </h2>
      </div>

      {!isAdmin && (
        <div className="mb-4 rounded-lg border border-border bg-raised/50 px-4 py-3 text-[0.857rem] text-text-muted">
          Only workspace owners and admins can edit configuration.
        </div>
      )}

      <div className="flex flex-col gap-5">
        {/* Section header */}
        <h3 className="text-[0.929rem] font-semibold text-text">Config</h3>

        {/* Provider */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[0.929rem] font-medium text-text-secondary">Provider</span>
          <div className="flex gap-1">
            {(["openrouter", "codex"] as const).map((p) => (
              <button
                key={p}
                type="button"
                disabled={!isAdmin}
                onClick={() => setProvider(p)}
                className={`cursor-pointer rounded-lg border px-4 py-2 text-[0.929rem] font-medium transition-colors ${
                  provider === p
                    ? "border-accent bg-accent/15 text-accent"
                    : "border-border bg-raised text-text-muted hover:bg-hover"
                } disabled:cursor-not-allowed disabled:opacity-50`}
              >
                {PROVIDER_LABELS[p]}
              </button>
            ))}
          </div>
        </div>

        {/* Per-provider config */}
        <div className="flex flex-col gap-4 rounded-lg border border-border bg-raised/50 p-4">
          <span className="text-[0.857rem] font-medium uppercase tracking-wider text-text-dimmed">
            {PROVIDER_LABELS[provider]} Settings
          </span>

          {/* OpenRouter settings */}
          {provider === "openrouter" && (
            <>
              <label className="flex flex-col gap-1.5">
                <span className="text-[0.929rem] font-medium text-text-secondary">API Key</span>
                <div className="flex gap-2">
                  <input
                    type={showKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="sk-or-..."
                    disabled={!isAdmin}
                    className="min-w-0 flex-1 rounded-lg border border-border bg-raised px-3 py-2 text-[0.929rem] text-text outline-none transition-colors placeholder:text-text-dimmed focus:border-accent disabled:cursor-not-allowed disabled:opacity-50"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((s) => !s)}
                    className="shrink-0 cursor-pointer rounded-lg border border-border bg-raised px-3 py-2 text-[0.857rem] text-text-muted transition-colors hover:bg-hover"
                  >
                    {showKey ? "Hide" : "Show"}
                  </button>
                </div>
              </label>

              <div className="flex flex-col gap-1.5">
                <span className="text-[0.929rem] font-medium text-text-secondary">Model</span>
                <input
                  type="text"
                  value={openrouterModel}
                  onChange={(e) => setOpenrouterModel(e.target.value)}
                  placeholder="e.g. openai/gpt-4.1"
                  disabled={!isAdmin}
                  className="rounded-lg border border-border bg-raised px-3 py-2 text-[0.929rem] text-text outline-none transition-colors placeholder:text-text-dimmed focus:border-accent disabled:cursor-not-allowed disabled:opacity-50"
                  spellCheck={false}
                />
              </div>
            </>
          )}

          {/* Codex settings */}
          {provider === "codex" && (
            <div className="flex flex-col gap-1.5">
              <span className="text-[0.929rem] font-medium text-text-secondary">Model</span>
              <ModelCombobox
                value={codexModel}
                onChange={setCodexModel}
                options={CODEX_MODELS}
              />
              <p className="text-[0.786rem] text-text-dimmed">
                Each user must connect their own ChatGPT account from their local settings.
              </p>
            </div>
          )}
        </div>

        {/* Reasoning Effort */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[0.929rem] font-medium text-text-secondary">Reasoning Effort</span>
          <div className="flex gap-1">
            {REASONING_EFFORTS.map((re) => (
              <button
                key={re.value}
                type="button"
                disabled={!isAdmin}
                onClick={() => setReasoningEffort(re.value)}
                className={`cursor-pointer rounded-lg border px-4 py-2 text-[0.929rem] font-medium transition-colors ${
                  reasoningEffort === re.value
                    ? "border-accent bg-accent/15 text-accent"
                    : "border-border bg-raised text-text-muted hover:bg-hover"
                } disabled:cursor-not-allowed disabled:opacity-50`}
              >
                {re.label}
              </button>
            ))}
          </div>
        </div>

        {/* Actions */}
        {isAdmin && (
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="cursor-pointer rounded-lg border-none bg-accent px-5 py-2 text-[0.929rem] font-medium text-white transition-colors hover:not-disabled:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save"}
            </button>
            {status === "error" && (
              <span className="text-[0.857rem] text-error-bright">
                {errorMsg || "Failed to save"}
              </span>
            )}
          </div>
        )}

        {status === "saved" && (
          <span className="text-[0.857rem] text-green-400">Settings saved</span>
        )}
      </div>
    </div>
  );
}
