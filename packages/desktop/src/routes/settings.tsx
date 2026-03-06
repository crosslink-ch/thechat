import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import type { AppConfig } from "@thechat/shared";

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
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-text-secondary">Model</span>
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="e.g. openai/gpt-4.1"
            className="rounded-lg border border-border bg-raised px-3 py-2 text-[13px] text-text outline-none transition-colors placeholder:text-text-dimmed focus:border-accent"
            spellCheck={false}
          />
        </label>

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

        {/* Restart required banner */}
        {status === "saved" && (
          <div className="flex items-center justify-between rounded-lg border border-warning/30 bg-warning/10 px-4 py-3">
            <span className="text-[13px] text-warning">Restart required to apply changes</span>
            <button
              type="button"
              onClick={() => relaunch()}
              className="cursor-pointer rounded-lg border-none bg-warning px-4 py-1.5 text-[12px] font-medium text-black transition-opacity hover:opacity-80"
            >
              Restart now
            </button>
          </div>
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
