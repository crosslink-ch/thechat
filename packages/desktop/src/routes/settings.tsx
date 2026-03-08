import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AppConfig } from "@thechat/shared";
import { ANTHROPIC_MODELS } from "../core/anthropic";
import { CODEX_MODELS } from "../core/codex";

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

  // Display the friendly name if the value matches a known model
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

  // Scroll active item into view
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
        className="w-full rounded-lg border border-border bg-raised px-3 py-2 text-[13px] text-text outline-none transition-colors placeholder:text-text-dimmed focus:border-accent"
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
              className={`cursor-pointer px-3 py-2 text-[13px] ${
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

export function SettingsRoute() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [provider, setProvider] = useState<"openrouter" | "codex" | "anthropic">("openrouter");
  const [model, setModel] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");
  const [configPath, setConfigPath] = useState<string | null>(null);

  useEffect(() => {
    invoke<AppConfig>("get_config").then((cfg) => {
      setConfig(cfg);
      setApiKey(cfg.api_key);
      setProvider(cfg.provider ?? "openrouter");
      setModel(cfg.model);
    });
    invoke<string>("get_config_path").then(setConfigPath);
  }, []);

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    setStatus("idle");
    try {
      const updated: AppConfig = {
        ...config,
        api_key: apiKey,
        provider,
        model,
      };
      await invoke("save_config", { config: updated });
      setConfig(updated);
      setStatus("saved");
    } catch {
      setStatus("error");
    } finally {
      setSaving(false);
    }
  };

  if (!config) {
    return (
      <div className="mx-auto h-full max-w-[600px] overflow-y-auto p-6">
        <div className="text-[13px] text-text-muted">Loading...</div>
      </div>
    );
  }

  return (
    <div className="mx-auto h-full max-w-[600px] overflow-y-auto p-6">
      <h2 className="mb-6 text-[17px] font-semibold tracking-tight text-text">Settings</h2>

      <div className="flex flex-col gap-5">
        {/* API Key */}
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-text-secondary">API Key</span>
          <div className="flex gap-2">
            <input
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="sk-or-..."
              className="min-w-0 flex-1 rounded-lg border border-border bg-raised px-3 py-2 text-[13px] text-text outline-none transition-colors placeholder:text-text-dimmed focus:border-accent"
              spellCheck={false}
            />
            <button
              type="button"
              onClick={() => setShowKey((s) => !s)}
              className="shrink-0 cursor-pointer rounded-lg border border-border bg-raised px-3 py-2 text-[12px] text-text-muted transition-colors hover:bg-hover"
            >
              {showKey ? "Hide" : "Show"}
            </button>
          </div>
        </label>

        {/* Provider */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-text-secondary">Provider</span>
          <div className="flex gap-1">
            {(["openrouter", "codex", "anthropic"] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setProvider(p)}
                className={`cursor-pointer rounded-lg border px-4 py-2 text-[13px] font-medium transition-colors ${
                  provider === p
                    ? "border-accent bg-accent/15 text-accent"
                    : "border-border bg-raised text-text-muted hover:bg-hover"
                }`}
              >
                {p === "openrouter" ? "OpenRouter" : p === "codex" ? "Codex" : "Anthropic"}
              </button>
            ))}
          </div>
        </div>

        {/* Model */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-text-secondary">Model</span>
          {provider === "openrouter" ? (
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="e.g. openai/gpt-4.1"
              className="rounded-lg border border-border bg-raised px-3 py-2 text-[13px] text-text outline-none transition-colors placeholder:text-text-dimmed focus:border-accent"
              spellCheck={false}
            />
          ) : (
            <ModelCombobox
              value={model}
              onChange={setModel}
              options={provider === "anthropic" ? ANTHROPIC_MODELS : CODEX_MODELS}
            />
          )}
        </div>

        {/* Save */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="cursor-pointer rounded-lg border-none bg-accent px-5 py-2 text-[13px] font-medium text-white transition-colors hover:not-disabled:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
          {status === "error" && (
            <span className="text-[12px] text-error-bright">Failed to save</span>
          )}
        </div>

        {status === "saved" && (
          <span className="text-[12px] text-green-400">Settings saved</span>
        )}
      </div>

      {configPath && (
        <p className="mt-8 text-[11px] text-text-dimmed">
          Settings are stored in <code className="rounded bg-raised px-1 py-0.5">{configPath}</code>. You can also edit this file directly.
        </p>
      )}
    </div>
  );
}
