import { useState, useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { WorkspaceConfig, WorkspaceProvider, ReasoningEffort } from "@thechat/shared";
import { CODEX_MODELS, GLM_MODELS } from "../core/models";
import { useAuthStore } from "../stores/auth";
import { useWorkspacesStore } from "../stores/workspaces";
import { api } from "../lib/api";
import { ModelCombobox } from "../components/ModelCombobox";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVIDER_LABELS: Record<WorkspaceProvider, string> = {
  openrouter: "OpenRouter",
  codex: "Codex",
  glm: "GLM",
  featherless: "Featherless",
};

const PROVIDER_ORDER: readonly WorkspaceProvider[] = ["openrouter", "codex", "glm", "featherless"];

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
  const selectWorkspace = useWorkspacesStore((s) => s.selectWorkspace);

  const [, setConfig] = useState<WorkspaceConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [provider, setProvider] = useState<WorkspaceProvider>("openrouter");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [openrouterModel, setOpenrouterModel] = useState("openai/gpt-4.1");
  const [codexModel, setCodexModel] = useState("gpt-5.4");
  const [glmApiKey, setGlmApiKey] = useState("");
  const [glmModel, setGlmModel] = useState("glm-5.1");
  const [showGlmKey, setShowGlmKey] = useState(false);
  const [featherlessApiKey, setFeatherlessApiKey] = useState("");
  const [featherlessModel, setFeatherlessModel] = useState("zai-org/GLM-5.1");
  const [showFeatherlessKey, setShowFeatherlessKey] = useState(false);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("xhigh");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [hermesName, setHermesName] = useState("Hermes");
  const [hermesBaseUrl, setHermesBaseUrl] = useState("http://localhost:18642");
  const [hermesApiKey, setHermesApiKey] = useState("");
  const [hermesInstructions, setHermesInstructions] = useState("Reply concisely in TheChat.");
  const [creatingHermes, setCreatingHermes] = useState(false);
  const [hermesStatus, setHermesStatus] = useState<"idle" | "created" | "error">("idle");
  const [hermesErrorMsg, setHermesErrorMsg] = useState<string | null>(null);

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
        if (cfg.glm) setGlmApiKey(cfg.glm.apiKey);
        if (cfg.glmModel) setGlmModel(cfg.glmModel);
        if (cfg.featherless) setFeatherlessApiKey(cfg.featherless.apiKey);
        if (cfg.featherlessModel) setFeatherlessModel(cfg.featherlessModel);
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

      // Save GLM API key if present
      if (glmApiKey.trim()) {
        const { error } = await api.workspaces({ id: activeWorkspace.id }).config.glm.put(
          { apiKey: glmApiKey.trim() },
          auth(token),
        );
        if (error) throw new Error((error as any).error || "Failed to save GLM config");
      }

      // Save Featherless API key if present
      if (featherlessApiKey.trim()) {
        const { error } = await api.workspaces({ id: activeWorkspace.id }).config.featherless.put(
          { apiKey: featherlessApiKey.trim() },
          auth(token),
        );
        if (error) throw new Error((error as any).error || "Failed to save Featherless config");
      }

      // Save model + reasoning settings
      const { error } = await api.workspaces({ id: activeWorkspace.id }).config.settings.put(
        {
          openrouterModel: openrouterModel || null,
          codexModel: codexModel || null,
          glmModel: glmModel || null,
          featherlessModel: featherlessModel || null,
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

  const handleCreateHermesBot = async () => {
    if (!token || !activeWorkspace) return;
    setCreatingHermes(true);
    setHermesStatus("idle");
    setHermesErrorMsg(null);
    try {
      const { error } = await api.bots.create.post(
        {
          kind: "hermes",
          workspaceId: activeWorkspace.id,
          name: hermesName.trim() || "Hermes",
          hermes: {
            baseUrl: hermesBaseUrl.trim(),
            apiKey: hermesApiKey.trim(),
            defaultMode: "run",
            defaultInstructions: hermesInstructions.trim() || null,
            defaultSessionScope: "channel",
          },
        },
        auth(token),
      );
      if (error) throw new Error((error as any).error || "Failed to create Hermes bot");
      setHermesStatus("created");
      setHermesApiKey("");
      await selectWorkspace(activeWorkspace.id);
    } catch (e) {
      setHermesStatus("error");
      setHermesErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setCreatingHermes(false);
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
          <div className="flex flex-wrap gap-1">
            {PROVIDER_ORDER.map((p) => (
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

          {/* Both panels rendered in the same grid cell so the container
              always keeps the height of the taller one, preventing layout shift. */}
          <div className="grid">
            {/* OpenRouter settings */}
            <div className={`col-start-1 row-start-1 flex flex-col gap-4 ${
              provider !== "openrouter" ? "invisible pointer-events-none" : ""
            }`}>
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
                    tabIndex={provider !== "openrouter" ? -1 : undefined}
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((s) => !s)}
                    className="shrink-0 cursor-pointer rounded-lg border border-border bg-raised px-3 py-2 text-[0.857rem] text-text-muted transition-colors hover:bg-hover"
                    tabIndex={provider !== "openrouter" ? -1 : undefined}
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
                  tabIndex={provider !== "openrouter" ? -1 : undefined}
                />
              </div>
            </div>

            {/* Codex settings */}
            <div className={`col-start-1 row-start-1 flex flex-col gap-1.5 ${
              provider !== "codex" ? "invisible pointer-events-none" : ""
            }`}>
              <span className="text-[0.929rem] font-medium text-text-secondary">Model</span>
              <ModelCombobox
                value={codexModel}
                onChange={setCodexModel}
                options={CODEX_MODELS}
                disabled={provider !== "codex"}
              />
              <p className="text-[0.786rem] text-text-dimmed">
                Each user must connect their own ChatGPT account from their local settings.
              </p>
            </div>

            {/* GLM settings */}
            <div className={`col-start-1 row-start-1 flex flex-col gap-4 ${
              provider !== "glm" ? "invisible pointer-events-none" : ""
            }`}>
              <label className="flex flex-col gap-1.5">
                <span className="text-[0.929rem] font-medium text-text-secondary">API Key</span>
                <div className="flex gap-2">
                  <input
                    type={showGlmKey ? "text" : "password"}
                    value={glmApiKey}
                    onChange={(e) => setGlmApiKey(e.target.value)}
                    placeholder="Z.ai API key"
                    disabled={!isAdmin}
                    className="min-w-0 flex-1 rounded-lg border border-border bg-raised px-3 py-2 text-[0.929rem] text-text outline-none transition-colors placeholder:text-text-dimmed focus:border-accent disabled:cursor-not-allowed disabled:opacity-50"
                    spellCheck={false}
                    tabIndex={provider !== "glm" ? -1 : undefined}
                  />
                  <button
                    type="button"
                    onClick={() => setShowGlmKey((s) => !s)}
                    className="shrink-0 cursor-pointer rounded-lg border border-border bg-raised px-3 py-2 text-[0.857rem] text-text-muted transition-colors hover:bg-hover"
                    tabIndex={provider !== "glm" ? -1 : undefined}
                  >
                    {showGlmKey ? "Hide" : "Show"}
                  </button>
                </div>
              </label>

              <div className="flex flex-col gap-1.5">
                <span className="text-[0.929rem] font-medium text-text-secondary">Model</span>
                <ModelCombobox
                  value={glmModel}
                  onChange={setGlmModel}
                  options={GLM_MODELS}
                  disabled={provider !== "glm"}
                />
              </div>
            </div>

            {/* Featherless settings */}
            <div className={`col-start-1 row-start-1 flex flex-col gap-4 ${
              provider !== "featherless" ? "invisible pointer-events-none" : ""
            }`}>
              <label className="flex flex-col gap-1.5">
                <span className="text-[0.929rem] font-medium text-text-secondary">API Key</span>
                <div className="flex gap-2">
                  <input
                    type={showFeatherlessKey ? "text" : "password"}
                    value={featherlessApiKey}
                    onChange={(e) => setFeatherlessApiKey(e.target.value)}
                    placeholder="Featherless API key"
                    disabled={!isAdmin}
                    className="min-w-0 flex-1 rounded-lg border border-border bg-raised px-3 py-2 text-[0.929rem] text-text outline-none transition-colors placeholder:text-text-dimmed focus:border-accent disabled:cursor-not-allowed disabled:opacity-50"
                    spellCheck={false}
                    tabIndex={provider !== "featherless" ? -1 : undefined}
                  />
                  <button
                    type="button"
                    onClick={() => setShowFeatherlessKey((s) => !s)}
                    className="shrink-0 cursor-pointer rounded-lg border border-border bg-raised px-3 py-2 text-[0.857rem] text-text-muted transition-colors hover:bg-hover"
                    tabIndex={provider !== "featherless" ? -1 : undefined}
                  >
                    {showFeatherlessKey ? "Hide" : "Show"}
                  </button>
                </div>
              </label>

              <div className="flex flex-col gap-1.5">
                <span className="text-[0.929rem] font-medium text-text-secondary">Model</span>
                <input
                  type="text"
                  value={featherlessModel}
                  onChange={(e) => setFeatherlessModel(e.target.value)}
                  placeholder="e.g. zai-org/GLM-5.1"
                  disabled={!isAdmin}
                  className="rounded-lg border border-border bg-raised px-3 py-2 text-[0.929rem] text-text outline-none transition-colors placeholder:text-text-dimmed focus:border-accent disabled:cursor-not-allowed disabled:opacity-50"
                  spellCheck={false}
                  tabIndex={provider !== "featherless" ? -1 : undefined}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Reasoning Effort — hidden for GLM (always-on thinking, no levels) */}
        {provider !== "glm" && (
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
        )}

        {/* Hermes bot */}
        <div className="flex flex-col gap-4 rounded-lg border border-border bg-raised/50 p-4">
          <div className="flex flex-col gap-1">
            <span className="text-[0.857rem] font-medium uppercase tracking-wider text-text-dimmed">
              Hermes Bot
            </span>
            <p className="text-[0.786rem] text-text-dimmed">
              Add a Hermes Agent runtime to this workspace. The API key is encrypted server-side and is never shown again.
            </p>
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-[0.929rem] font-medium text-text-secondary">Bot Name</span>
            <input
              type="text"
              value={hermesName}
              onChange={(e) => setHermesName(e.target.value)}
              disabled={!isAdmin}
              className="rounded-lg border border-border bg-raised px-3 py-2 text-[0.929rem] text-text outline-none transition-colors placeholder:text-text-dimmed focus:border-accent disabled:cursor-not-allowed disabled:opacity-50"
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[0.929rem] font-medium text-text-secondary">Hermes Base URL</span>
            <input
              type="url"
              value={hermesBaseUrl}
              onChange={(e) => setHermesBaseUrl(e.target.value)}
              placeholder="http://localhost:18642"
              disabled={!isAdmin}
              className="rounded-lg border border-border bg-raised px-3 py-2 text-[0.929rem] text-text outline-none transition-colors placeholder:text-text-dimmed focus:border-accent disabled:cursor-not-allowed disabled:opacity-50"
              spellCheck={false}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[0.929rem] font-medium text-text-secondary">Hermes API Key</span>
            <input
              type="password"
              value={hermesApiKey}
              onChange={(e) => setHermesApiKey(e.target.value)}
              placeholder="API_SERVER_KEY"
              disabled={!isAdmin}
              className="rounded-lg border border-border bg-raised px-3 py-2 text-[0.929rem] text-text outline-none transition-colors placeholder:text-text-dimmed focus:border-accent disabled:cursor-not-allowed disabled:opacity-50"
              spellCheck={false}
            />
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-[0.929rem] font-medium text-text-secondary">Default Instructions</span>
            <textarea
              value={hermesInstructions}
              onChange={(e) => setHermesInstructions(e.target.value)}
              disabled={!isAdmin}
              rows={3}
              className="resize-y rounded-lg border border-border bg-raised px-3 py-2 text-[0.929rem] text-text outline-none transition-colors placeholder:text-text-dimmed focus:border-accent disabled:cursor-not-allowed disabled:opacity-50"
            />
          </label>

          {isAdmin && (
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleCreateHermesBot}
                disabled={creatingHermes || !hermesBaseUrl.trim() || !hermesApiKey.trim()}
                className="cursor-pointer rounded-lg border border-border bg-raised px-4 py-2 text-[0.929rem] font-medium text-text-muted transition-colors hover:not-disabled:bg-hover hover:not-disabled:text-text disabled:cursor-not-allowed disabled:opacity-50"
              >
                {creatingHermes ? "Adding Hermes..." : "Add Hermes Bot"}
              </button>
              {hermesStatus === "created" && (
                <span className="text-[0.857rem] text-green-400">Hermes bot added. Mention it in a channel.</span>
              )}
              {hermesStatus === "error" && (
                <span className="text-[0.857rem] text-error-bright">
                  {hermesErrorMsg || "Failed to add Hermes bot"}
                </span>
              )}
            </div>
          )}
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
