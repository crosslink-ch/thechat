import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  AppConfig,
  Provider,
  ProvidersConfig,
  ReasoningEffort,
  LocalOverrides,
  WorkspaceConfig,
} from "@thechat/shared";
import { ANTHROPIC_MODELS, CODEX_MODELS } from "../core/models";
import { useUpdaterStore } from "../stores/updater";
import { useAuthStore } from "../stores/auth";
import { useWorkspacesStore } from "../stores/workspaces";
import { api } from "../lib/api";
import { invalidateWorkspaceConfigCache } from "../lib/effective-config";
import { ModelCombobox } from "../components/ModelCombobox";

// ---------------------------------------------------------------------------
// SourceToggle — "Workspace" / "Custom" switch for each field
// ---------------------------------------------------------------------------

function SourceToggle({
  isCustom,
  onToggle,
  disabled,
}: {
  isCustom: boolean;
  onToggle: (custom: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex gap-px rounded-md border border-border bg-raised">
      <button
        type="button"
        disabled={disabled}
        onClick={() => onToggle(false)}
        className={`cursor-pointer rounded-l-md border-none px-2 py-0.5 text-[0.714rem] font-medium transition-colors ${
          !isCustom
            ? "bg-accent/15 text-accent"
            : "bg-none text-text-dimmed hover:text-text-muted"
        } disabled:cursor-not-allowed disabled:opacity-50`}
      >
        Workspace
      </button>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onToggle(true)}
        className={`cursor-pointer rounded-r-md border-none px-2 py-0.5 text-[0.714rem] font-medium transition-colors ${
          isCustom
            ? "bg-accent/15 text-accent"
            : "bg-none text-text-dimmed hover:text-text-muted"
        } disabled:cursor-not-allowed disabled:opacity-50`}
      >
        Custom
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVIDER_LABELS: Record<Provider, string> = {
  openrouter: "OpenRouter",
  codex: "Codex",
  anthropic: "Anthropic",
};

const REASONING_EFFORTS: { value: ReasoningEffort; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Max" },
];

const DEFAULT_PROVIDERS: ProvidersConfig = {
  openrouter: { model: "openai/gpt-4.1" },
  codex: { model: "gpt-5.4" },
  anthropic: { model: "claude-sonnet-4-6" },
};

function authHeader(token: string) {
  return { headers: { authorization: `Bearer ${token}` } };
}

// ---------------------------------------------------------------------------
// Settings Route
// ---------------------------------------------------------------------------

export function SettingsRoute() {
  // Local config state
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [provider, setProvider] = useState<Provider>("openrouter");
  const [providers, setProviders] = useState<ProvidersConfig>(DEFAULT_PROVIDERS);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("xhigh");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");
  const [configPath, setConfigPath] = useState<string | null>(null);

  // Workspace inheritance state
  const [inheritWorkspaceId, setInheritWorkspaceId] = useState<string | null>(null);
  const [localOverrides, setLocalOverrides] = useState<LocalOverrides>({});
  const [wsConfig, setWsConfig] = useState<WorkspaceConfig | null>(null);
  const [wsConfigLoading, setWsConfigLoading] = useState(false);

  // Auth & workspace stores
  const token = useAuthStore((s) => s.token);
  const workspaces = useWorkspacesStore((s) => s.workspaces);

  // Updater
  const checkingForUpdates = useUpdaterStore((s) => s.checking);
  const updaterError = useUpdaterStore((s) => s.error);
  const updaterStatusMessage = useUpdaterStore((s) => s.statusMessage);
  const runUpdateCheck = useUpdaterStore((s) => s.checkForUpdates);
  const clearUpdaterStatusMessage = useUpdaterStore((s) => s.clearStatusMessage);

  // Load local config on mount
  useEffect(() => {
    invoke<AppConfig>("get_config").then((cfg) => {
      setConfig(cfg);
      setApiKey(cfg.api_key);
      setProvider(cfg.provider ?? "openrouter");
      setProviders(cfg.providers ?? DEFAULT_PROVIDERS);
      setReasoningEffort(cfg.reasoningEffort ?? "xhigh");
      setInheritWorkspaceId(cfg.inheritWorkspaceId ?? null);
      setLocalOverrides(cfg.localOverrides ?? {});
    });
    invoke<string>("get_config_path").then(setConfigPath);
  }, []);

  // Fetch workspace config when inheritWorkspaceId changes
  useEffect(() => {
    if (!inheritWorkspaceId || !token) {
      setWsConfig(null);
      return;
    }

    setWsConfigLoading(true);
    api.workspaces({ id: inheritWorkspaceId }).config.get(authHeader(token))
      .then(({ data, error }) => {
        if (error) {
          setWsConfig(null);
        } else {
          setWsConfig(data as WorkspaceConfig);
        }
      })
      .catch(() => setWsConfig(null))
      .finally(() => setWsConfigLoading(false));
  }, [inheritWorkspaceId, token]);

  useEffect(() => {
    if (!updaterStatusMessage) return;
    const timeout = window.setTimeout(() => {
      clearUpdaterStatusMessage();
    }, 4000);
    return () => window.clearTimeout(timeout);
  }, [clearUpdaterStatusMessage, updaterStatusMessage]);

  const setProviderModel = (model: string) => {
    setProviders((prev) => ({
      ...prev,
      [provider]: { ...prev[provider], model },
    }));
  };

  const toggleOverride = (field: keyof LocalOverrides, custom: boolean) => {
    setLocalOverrides((prev) => ({ ...prev, [field]: custom || undefined }));
  };

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    setStatus("idle");
    try {
      const updated: AppConfig = {
        ...config,
        api_key: apiKey,
        provider,
        reasoningEffort,
        providers,
        inheritWorkspaceId: inheritWorkspaceId ?? undefined,
        localOverrides: inheritWorkspaceId ? localOverrides : undefined,
      };
      await invoke("save_config", { config: updated });
      setConfig(updated);
      invalidateWorkspaceConfigCache();
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
        <div className="text-[0.929rem] text-text-muted">Loading...</div>
      </div>
    );
  }

  // Whether workspace inheritance is active and has config
  const wsActive = !!inheritWorkspaceId && !!wsConfig;

  // Helper: does workspace have a value for a given field?
  const wsHasProvider = wsActive && !!wsConfig.provider;
  const wsHasApiKey = wsActive && !!wsConfig.openrouter?.apiKey;
  const wsHasOpenrouterModel = wsActive && !!wsConfig.openrouterModel;
  const wsHasCodexModel = wsActive && !!wsConfig.codexModel;
  const wsHasReasoningEffort = wsActive && !!wsConfig.reasoningEffort;

  // Effective values for display (workspace or local)
  const effectiveProvider = (!localOverrides.provider && wsHasProvider)
    ? wsConfig!.provider! as Provider
    : provider;

  const currentModel = providers[effectiveProvider]?.model ?? providers[provider]?.model;

  // For model field: determine which workspace model applies
  const wsModelForCurrentProvider =
    effectiveProvider === "openrouter" ? wsConfig?.openrouterModel
    : effectiveProvider === "codex" ? wsConfig?.codexModel
    : null;
  const wsHasModelForProvider =
    effectiveProvider === "openrouter" ? wsHasOpenrouterModel
    : effectiveProvider === "codex" ? wsHasCodexModel
    : false;
  const modelOverrideKey: keyof LocalOverrides =
    effectiveProvider === "openrouter" ? "openrouterModel" : "codexModel";
  const isModelCustom = !!localOverrides[modelOverrideKey];

  return (
    <div className="mx-auto h-full max-w-[600px] overflow-y-auto p-6">
      <h2 className="mb-6 text-[1.214rem] font-semibold tracking-tight text-text">Settings</h2>

      <div className="flex flex-col gap-5">
        {/* Workspace inheritance */}
        {token && workspaces.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <span className="text-[0.929rem] font-medium text-text-secondary">
              Inherit config from workspace
            </span>
            <select
              value={inheritWorkspaceId ?? ""}
              onChange={(e) => {
                const val = e.target.value || null;
                setInheritWorkspaceId(val);
                if (!val) {
                  setLocalOverrides({});
                }
              }}
              className="rounded-lg border border-border bg-raised px-3 py-2 text-[0.929rem] text-text outline-none transition-colors focus:border-accent"
            >
              <option value="">None</option>
              {workspaces.map((ws) => (
                <option key={ws.id} value={ws.id}>{ws.name}</option>
              ))}
            </select>
            {wsConfigLoading && (
              <span className="text-[0.786rem] text-text-dimmed">Loading workspace config...</span>
            )}
            {wsActive && (
              <span className="text-[0.786rem] text-text-dimmed">
                Fields default to workspace values unless set to Custom.
              </span>
            )}
          </div>
        )}

        {/* Provider */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="text-[0.929rem] font-medium text-text-secondary">Provider</span>
            {wsHasProvider && (
              <SourceToggle
                isCustom={!!localOverrides.provider}
                onToggle={(c) => toggleOverride("provider", c)}
              />
            )}
          </div>
          {wsHasProvider && !localOverrides.provider ? (
            <div className="flex gap-1">
              {(["openrouter", "codex", "anthropic"] as const).map((p) => (
                <div
                  key={p}
                  className={`rounded-lg border px-4 py-2 text-[0.929rem] font-medium ${
                    effectiveProvider === p
                      ? "border-accent/50 bg-accent/10 text-accent/70"
                      : "border-border bg-raised text-text-dimmed"
                  }`}
                >
                  {PROVIDER_LABELS[p]}
                </div>
              ))}
            </div>
          ) : (
            <div className="flex gap-1">
              {(["openrouter", "codex", "anthropic"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setProvider(p)}
                  className={`cursor-pointer rounded-lg border px-4 py-2 text-[0.929rem] font-medium transition-colors ${
                    provider === p
                      ? "border-accent bg-accent/15 text-accent"
                      : "border-border bg-raised text-text-muted hover:bg-hover"
                  }`}
                >
                  {PROVIDER_LABELS[p]}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Per-provider config */}
        <div className="flex flex-col gap-4 rounded-lg border border-border bg-raised/50 p-4">
          <span className="text-[0.857rem] font-medium uppercase tracking-wider text-text-dimmed">
            {PROVIDER_LABELS[effectiveProvider]} Settings
          </span>

          {/* API Key — only for OpenRouter */}
          {effectiveProvider === "openrouter" && (
            <label className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <span className="text-[0.929rem] font-medium text-text-secondary">API Key</span>
                {wsHasApiKey && (
                  <SourceToggle
                    isCustom={!!localOverrides.apiKey}
                    onToggle={(c) => toggleOverride("apiKey", c)}
                  />
                )}
              </div>
              {wsHasApiKey && !localOverrides.apiKey ? (
                <div className="rounded-lg border border-border bg-raised px-3 py-2 text-[0.929rem] text-text-dimmed">
                  {wsConfig!.openrouter!.apiKey.slice(0, 8)}{"..."}
                </div>
              ) : (
                <div className="flex gap-2">
                  <input
                    type={showKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="sk-or-..."
                    className="min-w-0 flex-1 rounded-lg border border-border bg-raised px-3 py-2 text-[0.929rem] text-text outline-none transition-colors placeholder:text-text-dimmed focus:border-accent"
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
              )}
            </label>
          )}

          {/* Model */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <span className="text-[0.929rem] font-medium text-text-secondary">Model</span>
              {wsHasModelForProvider && (
                <SourceToggle
                  isCustom={isModelCustom}
                  onToggle={(c) => toggleOverride(modelOverrideKey, c)}
                />
              )}
            </div>
            {wsHasModelForProvider && !isModelCustom ? (
              <div className="rounded-lg border border-border bg-raised px-3 py-2 text-[0.929rem] text-text-dimmed">
                {wsModelForCurrentProvider}
              </div>
            ) : effectiveProvider === "openrouter" ? (
              <input
                type="text"
                value={currentModel}
                onChange={(e) => setProviderModel(e.target.value)}
                placeholder="e.g. openai/gpt-4.1"
                className="rounded-lg border border-border bg-raised px-3 py-2 text-[0.929rem] text-text outline-none transition-colors placeholder:text-text-dimmed focus:border-accent"
                spellCheck={false}
              />
            ) : (
              <ModelCombobox
                value={currentModel}
                onChange={setProviderModel}
                options={effectiveProvider === "anthropic" ? ANTHROPIC_MODELS : CODEX_MODELS}
              />
            )}
          </div>
        </div>

        {/* Reasoning Effort */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="text-[0.929rem] font-medium text-text-secondary">Reasoning Effort</span>
            {wsHasReasoningEffort && (
              <SourceToggle
                isCustom={!!localOverrides.reasoningEffort}
                onToggle={(c) => toggleOverride("reasoningEffort", c)}
              />
            )}
          </div>
          {wsHasReasoningEffort && !localOverrides.reasoningEffort ? (
            <div className="flex gap-1">
              {REASONING_EFFORTS.map((re) => (
                <div
                  key={re.value}
                  className={`rounded-lg border px-4 py-2 text-[0.929rem] font-medium ${
                    wsConfig!.reasoningEffort === re.value
                      ? "border-accent/50 bg-accent/10 text-accent/70"
                      : "border-border bg-raised text-text-dimmed"
                  }`}
                >
                  {re.label}
                </div>
              ))}
            </div>
          ) : (
            <div className="flex gap-1">
              {REASONING_EFFORTS.map((re) => (
                <button
                  key={re.value}
                  type="button"
                  onClick={() => setReasoningEffort(re.value)}
                  className={`cursor-pointer rounded-lg border px-4 py-2 text-[0.929rem] font-medium transition-colors ${
                    reasoningEffort === re.value
                      ? "border-accent bg-accent/15 text-accent"
                      : "border-border bg-raised text-text-muted hover:bg-hover"
                  }`}
                >
                  {re.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="cursor-pointer rounded-lg border-none bg-accent px-5 py-2 text-[0.929rem] font-medium text-white transition-colors hover:not-disabled:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
          <button
            type="button"
            onClick={() => {
              void runUpdateCheck();
            }}
            disabled={checkingForUpdates}
            className="cursor-pointer rounded-lg border border-border bg-raised px-4 py-2 text-[0.929rem] font-medium text-text transition-colors hover:not-disabled:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {checkingForUpdates ? "Checking..." : "Check for updates"}
          </button>
          {status === "error" && (
            <span className="text-[0.857rem] text-error-bright">Failed to save</span>
          )}
        </div>

        {status === "saved" && (
          <span className="text-[0.857rem] text-green-400">Settings saved</span>
        )}
        {updaterStatusMessage && (
          <span className="text-[0.857rem] text-text-muted">{updaterStatusMessage}</span>
        )}
        {updaterError && !checkingForUpdates && (
          <span className="text-[0.857rem] text-error-bright">{updaterError}</span>
        )}
      </div>

      {configPath && (
        <p className="mt-8 text-[0.786rem] text-text-dimmed">
          Settings are stored in <code className="rounded bg-raised px-1 py-0.5">{configPath}</code>. You can also edit this file directly.
        </p>
      )}
    </div>
  );
}
