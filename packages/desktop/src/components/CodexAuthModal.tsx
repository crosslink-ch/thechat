import { useEffect } from "react";
import { create } from "zustand";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCodexAuthStore } from "../stores/codex-auth";

// Colocated visibility store
const useCodexAuthModalState = create(() => ({ open: false }));
export const openCodexAuthModal = () => useCodexAuthModalState.setState({ open: true });
const closeCodexAuthModal = () => useCodexAuthModalState.setState({ open: false });

export function CodexAuthModal() {
  const open = useCodexAuthModalState((s) => s.open);
  if (!open) return null;
  return <CodexAuthModalInner />;
}

function CodexAuthModalInner() {
  const status = useCodexAuthStore((s) => s.status);
  const userCode = useCodexAuthStore((s) => s.userCode);
  const verificationUrl = useCodexAuthStore((s) => s.verificationUrl);
  const error = useCodexAuthStore((s) => s.error);
  const startLogin = useCodexAuthStore((s) => s.startLogin);
  const cancelLogin = useCodexAuthStore((s) => s.cancelLogin);
  const logout = useCodexAuthStore((s) => s.logout);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (status === "polling" || status === "awaiting_code") {
          cancelLogin();
        }
        closeCodexAuthModal();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [status, cancelLogin]);

  const handleStartLogin = () => {
    startLogin();
  };

  const handleOpenVerification = () => {
    openUrl(verificationUrl);
  };

  const handleCopyCode = () => {
    if (userCode) {
      navigator.clipboard.writeText(userCode);
    }
  };

  const handleDisconnect = async () => {
    await logout();
    closeCodexAuthModal();
  };

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-overlay" onClick={closeCodexAuthModal}>
      <div className="w-full max-w-[420px] rounded-xl border border-border bg-surface p-6 shadow-card" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-5 text-lg font-semibold text-text">
          ChatGPT Pro/Plus
        </h2>

        {/* Idle / Not connected state */}
        {(status === "idle" || status === "error") && (
          <>
            <p className="mb-4 text-[13px] leading-relaxed text-text-muted">
              Connect your ChatGPT Pro or Plus subscription to use Codex models for free.
              This uses OpenAI's device authorization flow.
            </p>

            {error && (
              <div className="mb-3 rounded-md border border-error-msg-border bg-error-msg-bg px-3 py-2 text-[13px] text-error-bright">
                {error}
              </div>
            )}

            <button
              className="block w-full cursor-pointer rounded-lg border border-border-strong bg-elevated px-2.5 py-2.5 font-[inherit] text-sm font-medium text-text hover:bg-border-strong"
              onClick={handleStartLogin}
            >
              Connect ChatGPT Account
            </button>
          </>
        )}

        {/* Awaiting code / Polling state */}
        {(status === "awaiting_code" || status === "polling") && (
          <>
            {!userCode ? (
              <p className="mb-4 text-center text-[13px] text-text-muted">
                Generating device code...
              </p>
            ) : (
              <>
                <p className="mb-3 text-[13px] leading-relaxed text-text-muted">
                  Enter this code at the OpenAI verification page:
                </p>

                <button
                  className="mx-auto mb-4 flex cursor-pointer items-center gap-2 rounded-lg border border-border-strong bg-base px-6 py-3 font-mono text-2xl font-bold tracking-[0.15em] text-text hover:bg-hover"
                  onClick={handleCopyCode}
                  title="Click to copy"
                >
                  {userCode}
                  <span className="text-[11px] font-normal tracking-normal text-text-dimmed">copy</span>
                </button>

                <button
                  className="mb-3 block w-full cursor-pointer rounded-lg border border-border-strong bg-elevated px-2.5 py-2.5 font-[inherit] text-sm font-medium text-text hover:bg-border-strong"
                  onClick={handleOpenVerification}
                >
                  Open Verification Page
                </button>

                <p className="mb-4 text-center text-[12px] text-text-dimmed">
                  Waiting for authorization...
                </p>
              </>
            )}

            <button
              className="block w-full cursor-pointer rounded-lg border border-border bg-none px-2.5 py-2 font-[inherit] text-[13px] text-text-muted hover:bg-hover hover:text-text"
              onClick={() => {
                cancelLogin();
                closeCodexAuthModal();
              }}
            >
              Cancel
            </button>
          </>
        )}

        {/* Authenticated state */}
        {status === "authenticated" && (
          <>
            <div className="mb-4 flex items-center gap-2 rounded-lg border border-success-border bg-success-bg px-3 py-2.5">
              <span className="text-[13px] font-medium text-success-light">Connected</span>
              <span className="text-[12px] text-text-muted">
                Codex models are available
              </span>
            </div>

            <p className="mb-4 text-[13px] leading-relaxed text-text-muted">
              Set <code className="rounded bg-base px-1 py-0.5 text-[12px]">"provider": "codex"</code> in your config.json to route messages through Codex.
            </p>

            <button
              className="block w-full cursor-pointer rounded-lg border border-border bg-none px-2.5 py-2.5 font-[inherit] text-[13px] text-text-muted hover:bg-hover hover:text-text"
              onClick={closeCodexAuthModal}
            >
              Close
            </button>
          </>
        )}
      </div>
    </div>
  );
}
