import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import type {
  AcpPermissionMode,
  AcpProfile,
  AppConfig,
  Conversation,
} from "@thechat/shared";
import { ChatMessage, StreamingMessage } from "../ChatMessage";
import { InputBar } from "../components/InputBar";
import { ProjectPicker } from "../components/ProjectPicker";
import { AgentProfilePicker } from "../components/AgentProfilePicker";
import { AcpPermissionPrompt } from "../components/AcpPermissionPrompt";
import {
  setAgentChatHeaderContext,
  setAgentChatProjectDir,
  setAgentChatTitle,
} from "../components/ChatHeader";
import { useAcpChat } from "../hooks/useAcpChat";
import type { ImageAttachment } from "../lib/images";
import { composerDraftKey, useComposerDraftsStore } from "../stores/composer-drafts";
import { usePermissionModeStore } from "../stores/permission-mode";
import { useConversationsStore } from "../stores/conversations";

export function AgentChatRoute() {
  const params = useParams({ strict: false }) as { id?: string };
  const search = useSearch({ strict: false }) as { projectDir?: string };
  const navigate = useNavigate();
  const routeConversationId = params.id;
  const permissionSetting = usePermissionModeStore((state) => state.mode);
  const permissionMode = toAcpPermissionMode(permissionSetting);

  const [profiles, setProfiles] = useState<AcpProfile[]>([]);

  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [projectDir, setProjectDir] = useState<string | null>(
    search.projectDir ?? null,
  );
  const [routeConversation, setRouteConversation] =
    useState<Conversation | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [conversationLoading, setConversationLoading] = useState(
    Boolean(routeConversationId),
  );
  const [routeError, setRouteError] = useState<string | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [composerEpoch, setComposerEpoch] = useState(0);
  const promotionActionRef = useRef<{
    phase: "pending" | "clear" | "move";
    expectedRevision: number;
    submittedImageIds: string[];
  } | null>(null);
  const [promotionEpoch, setPromotionEpoch] = useState(0);
  const selectedProfile = profiles.find(
    (profile) => profile.id === selectedProfileId,
  );
  const profileAvailable = Boolean(selectedProfile && !selectedProfile.disabled);

  const handleStreamComplete = useCallback(
    (conversationId: string, _title: string, visible: boolean) => {
      if (visible) {
        useConversationsStore.getState().markAgentChatRead(conversationId);
      } else {
        useConversationsStore.getState().markAgentChatUnread(conversationId);
      }
    },
    [],
  );

  const chat = useAcpChat({
    profileId: selectedProfileId,
    projectDir,
    permissionMode,
    profileAvailable,
    onStreamComplete: handleStreamComplete,
  });
  const {
    conversation,
    messages,
    loadingMessages: loading,
    loadingOlderMessages: loadingOlder,
    hasOlderMessages: hasMore,
    error,
    isBusy,
    capabilities,
    status,
    pendingPermission,
    sendMessage,
    stopStreaming,
    respondToPermission,
    loadConversation,
    loadOlderMessages,
    startNewConversation,
  } = chat;
  const activeConversation = conversation ?? routeConversation;
  const profileLocked = Boolean(routeConversationId || activeConversation);
  const projectLocked = profileLocked;

  const loadConfig = useCallback(async () => {
    setConfigLoading(true);
    setConfigError(null);
    try {
      const next = await invoke<AppConfig>("get_config");
      const nextProfiles = next.acpProfiles ?? [];
      setProfiles(nextProfiles);

      setSelectedProfileId((current) => {
        if (routeConversationId || current) return current;
        const configuredDefault = nextProfiles.find(
          (profile) =>
            profile.id === next.defaultAcpProfileId && !profile.disabled,
        );
        return (
          configuredDefault?.id ??
          nextProfiles.find((profile) => !profile.disabled)?.id ??
          null
        );
      });
    } catch (loadError) {
      setConfigError(errorMessage(loadError));
    } finally {
      setConfigLoading(false);
    }
  }, [routeConversationId]);

  useEffect(() => {
    void loadConfig();
    const reload = () => void loadConfig();
    window.addEventListener("acp-profiles-changed", reload);
    return () => window.removeEventListener("acp-profiles-changed", reload);
  }, [loadConfig]);

  useEffect(() => {
    if (routeConversationId || search.projectDir) return;
    let active = true;
    void invoke<string | null>("get_initial_project_dir")
      .then((initialProjectDir) => {
        if (active && initialProjectDir) {
          setProjectDir((current) => current ?? initialProjectDir);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [routeConversationId, search.projectDir]);

  useEffect(() => {
    let active = true;
    if (!routeConversationId) {
      setConversationLoading(false);
      setRouteConversation(null);
      setRouteError(null);
      startNewConversation();
      return () => {
        active = false;
      };
    }

    setConversationLoading(true);
    setRouteError(null);
    void invoke<Conversation>("get_conversation", { id: routeConversationId })
      .then(async (loadedConversation) => {
        if (!active) return;
        setRouteConversation(loadedConversation);
        setProjectDir(loadedConversation.project_dir);
        setSelectedProfileId(loadedConversation.agent_profile_id ?? null);
        if (!loadedConversation.agent_profile_id) {
          setRouteError(
            "This hidden legacy conversation is not an ACP session. Start a new Agent Chat instead.",
          );
          return;
        }
        await loadConversation(loadedConversation);
        if (active) {
          useConversationsStore
            .getState()
            .markAgentChatRead(loadedConversation.id);
        }
      })
      .catch((loadError) => {
        if (active) setRouteError(errorMessage(loadError));
      })
      .finally(() => {
        if (active) setConversationLoading(false);
      });

    return () => {
      active = false;
    };
  }, [loadConversation, routeConversationId, startNewConversation]);

  useEffect(() => {
    if (routeConversationId || !conversation?.id || isBusy) return;
    const action = promotionActionRef.current;
    if (action?.phase === "pending") return;
    const sourceKey = composerDraftKey.agent(undefined);
    const destinationKey = composerDraftKey.agent(conversation.id);
    const drafts = useComposerDraftsStore.getState();
    if (action?.phase === "clear") {
      drafts.acknowledgeSubmission(
        sourceKey,
        action.expectedRevision,
        action.submittedImageIds,
      );
    }
    drafts.moveDraft(sourceKey, destinationKey);
    promotionActionRef.current = null;
    void useConversationsStore.getState().fetchConversations();
    useConversationsStore.getState().markAgentChatRead(conversation.id);
    void navigate({
      to: "/chat/$id",
      params: { id: conversation.id },
      replace: true,
    });
  }, [conversation?.id, isBusy, navigate, promotionEpoch, routeConversationId]);

  useEffect(() => {
    const title = activeConversation?.title ?? "New Agent Chat";
    setAgentChatTitle(title);
    setAgentChatProjectDir(projectDir);
    setAgentChatHeaderContext({
      profiles,
      selectedProfileId,
      profileLocked,
      projectDir,
      projectLocked,
      status,
      capabilities,
      onSelectProfile: (profileId) => {
        if (!profileLocked) setSelectedProfileId(profileId);
      },
      onSelectProject: (directory) => {
        if (!projectLocked) setProjectDir(directory);
      },
    });
    return () => setAgentChatHeaderContext(null);
  }, [
    activeConversation?.title,
    capabilities,
    profileLocked,
    profiles,
    projectDir,
    projectLocked,
    selectedProfileId,
    status,
  ]);


  const disabledReason = useMemo(() => {
    if (routeError) return routeError;
    if (configLoading || conversationLoading) return "Loading ACP configuration...";
    if (configError) return `Could not load agent profiles: ${configError}`;
    if (!selectedProfileId) return "Select an enabled agent profile first.";
    if (!selectedProfile) {
      return `Profile ${selectedProfileId} is unavailable. Restore it in Settings or start a new conversation.`;
    }
    if (selectedProfile.disabled) {
      return `Profile ${selectedProfile.name} is disabled. Re-enable it in Settings or start a new conversation.`;
    }
    if (!projectDir) return "Select a project directory first.";
    return null;
  }, [
    configError,
    configLoading,
    conversationLoading,
    projectDir,
    routeError,
    selectedProfile,
    selectedProfileId,
  ]);

  const submit = useCallback(
    async (content: string, images?: ImageAttachment[]) => {
      if (disabledReason) return false;
      const isPromotingConversation = !routeConversationId;
      const promotionSnapshot = isPromotingConversation
        ? {
            expectedRevision:
              useComposerDraftsStore.getState().revisions[
                composerDraftKey.agent(undefined)
              ] ?? 0,
            submittedImageIds: (images ?? []).map((image) => image.id),
          }
        : null;
      if (promotionSnapshot) {
        promotionActionRef.current = { phase: "pending", ...promotionSnapshot };
      }
      const accepted = await sendMessage(content, images);
      if (promotionSnapshot) {
        promotionActionRef.current = {
          phase: accepted ? "clear" : "move",
          ...promotionSnapshot,
        };
        setPromotionEpoch((current) => current + 1);
      }
      if (accepted) setComposerEpoch((current) => current + 1);
      return accepted;
    },
    [disabledReason, routeConversationId, sendMessage],
  );

  const answerPermission = useCallback(
    async (optionId: string) => {
      if (!pendingPermission || permissionBusy) return;
      setPermissionBusy(true);
      try {
        await respondToPermission(optionId);
      } finally {
        setPermissionBusy(false);
      }
    }, [pendingPermission, permissionBusy, respondToPermission],
  );

  const showWelcome =
    !activeConversation && messages.length === 0 && !loading && !conversationLoading;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-base">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {hasMore && activeConversation && (
          <div className="mb-4 flex justify-center">
            <button
              type="button"
              disabled={loadingOlder}
              onClick={() => void loadOlderMessages()}
              className="rounded-md border border-border bg-raised px-3 py-1.5 text-[0.786rem] text-text-muted hover:bg-hover disabled:opacity-50"
            >
              {loadingOlder ? "Loading earlier messages..." : "Load earlier messages"}
            </button>
          </div>
        )}

        {showWelcome && (
          <section className="mx-auto flex min-h-full max-w-xl flex-col items-center justify-center gap-4 text-center">
            <div>
              <h1 className="text-[1.25rem] font-semibold text-text">
                Start an ACP Agent Chat
              </h1>
              <p className="mt-1 text-[0.857rem] leading-5 text-text-muted">
                Choose a trusted local adapter profile and a project directory. Both become
                immutable when the first prompt creates the conversation.
              </p>
            </div>
            <div className="flex flex-wrap items-start justify-center gap-3">
              <AgentProfilePicker
                profiles={profiles}
                value={selectedProfileId}
                onChange={setSelectedProfileId}
              />
              <div className="flex flex-col items-start gap-1">
                <ProjectPicker projectDir={projectDir} onSelect={setProjectDir} />
                <span className="text-[0.714rem] text-text-dimmed">Working directory</span>
              </div>
            </div>
            {profiles.length === 0 && !configLoading && !configError && (
              <button
                type="button"
                onClick={() => navigate({ to: "/settings" })}
                className="rounded-md border border-border bg-raised px-3 py-1.5 text-[0.786rem] text-accent hover:bg-hover"
              >
                Create an agent profile in Settings
              </button>
            )}
            <p className="max-w-lg text-[0.714rem] leading-5 text-text-dimmed">
              The adapter runs with your desktop OS identity. Approval prompts are cooperative
              controls, not sandbox boundaries.
            </p>
          </section>
        )}

        {!showWelcome && (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-1">
            {messages.map((message) => (
              <ChatMessage key={message.id} message={message} />
            ))}
            {activeConversation && <StreamingMessage convId={activeConversation.id} />}
            {pendingPermission && (
              <AcpPermissionPrompt
                request={pendingPermission}
                onChoice={(optionId) => void answerPermission(optionId)}
                busy={permissionBusy}
              />
            )}
          </div>
        )}
      </div>

      {(routeError || configError || error) && (
        <div className="mx-4 mb-2 flex items-start justify-between gap-3 rounded-lg border border-error/30 bg-error/10 px-3 py-2">
          <p role="alert" className="text-[0.786rem] text-error-bright">
            {routeError ?? configError ?? error?.message}
          </p>
          {configError && (
            <button
              type="button"
              onClick={() => void loadConfig()}
              className="shrink-0 text-[0.714rem] font-medium text-error-bright underline"
            >
              Retry
            </button>
          )}
        </div>
      )}

      <InputBar
        key={`${routeConversationId ?? "new"}:${composerEpoch}`}
        convId={activeConversation?.id}
        draftKey={composerDraftKey.agent(routeConversationId)}
        onSend={submit}
        onStop={() => void stopStreaming()}
        isStreamingOverride={isBusy}
        allowQueueWhileStreaming={false}
        allowImages={capabilities?.prompt?.image === true}
        disabled={Boolean(disabledReason)}
        disabledReason={disabledReason ?? undefined}
      />
    </div>
  );
}

function toAcpPermissionMode(
  permissionMode:
    | "strict"
    | "request"
    | "allow-edits"
    | "bypass"
    | "default"
    | "accept_edits"
    | "bypass_permissions",
): AcpPermissionMode {
  switch (permissionMode) {
    case "allow-edits":
    case "accept_edits":
      return "allow-edits";
    case "bypass":
    case "bypass_permissions":
      return "bypass";
    default:
      return "request";
  }
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "The ACP conversation could not be loaded.";
}
