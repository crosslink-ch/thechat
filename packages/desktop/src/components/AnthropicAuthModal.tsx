import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAnthropicAuthStore } from "../stores/anthropic-auth";

// Colocated visibility store
const useAnthropicAuthModalState = create(() => ({ open: false }));
export const openAnthropicAuthModal = () => useAnthropicAuthModalState.setState({ open: true });
const closeAnthropicAuthModal = () => useAnthropicAuthModalState.setState({ open: false });

export function AnthropicAuthModal() {
  const open = useAnthropicAuthModalState((s) => s.open);
  if (!open) return null;
  return <AnthropicAuthModalInner />;
}

function AnthropicAuthModalInner() {
  const status = useAnthropicAuthStore((s) => s.status);
  const authUrl = useAnthropicAuthStore((s) => s.authUrl);
  const error = useAnthropicAuthStore((s) => s.error);
  const startLogin = useAnthropicAuthStore((s) => s.startLogin);
  const submitCode = useAnthropicAuthStore((s) => s.submitCode);
  const cancelLogin = useAnthropicAuthStore((s) => s.cancelLogin);
  const logout = useAnthropicAuthStore((s) => s.logout);

  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const wasAuthenticatedOnOpen = useRef(status === "authenticated");

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (status === "awaiting_code") {
          cancelLogin();
        }
        closeAnthropicAuthModal();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [status, cancelLogin]);

  // Focus the code input when it appears
  useEffect(() => {
    if (status === "awaiting_code" && authUrl) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [status, authUrl]);

  const handleStartLogin = () => {
    startLogin();
  };

  const handleOpenAuthPage = () => {
    if (authUrl) openUrl(authUrl);
  };

  const handleSubmitCode = async () => {
    if (!code.trim()) return;
    setSubmitting(true);
    await submitCode(code);
    setSubmitting(false);
    setCode("");
  };

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-overlay backdrop-blur-[2px] animate-fade-in" onClick={closeAnthropicAuthModal}>
      <div className="w-full max-w-[420px] rounded-xl border border-border-strong bg-surface p-6 shadow-card animate-slide-up" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-5 text-[1.214rem] font-semibold tracking-tight text-text">
          Claude Pro/Max
        </h2>

        {/* Idle / Not connected / Error state */}
        {(status === "idle" || status === "error") && (
          <>
            <p className="mb-4 text-[0.929rem] leading-relaxed text-text-muted">
              Connect your Claude Pro or Max subscription to use Claude models.
              This uses Anthropic's OAuth authorization flow.
            </p>

            {error && (
              <div className="mb-3 rounded-lg border border-error-msg-border bg-error-msg-bg px-3 py-2 text-[0.857rem] text-error-bright">
                {error}
              </div>
            )}

            <button
              className="block w-full cursor-pointer rounded-lg border border-border-strong bg-elevated px-3 py-2.5 font-[inherit] text-[0.929rem] font-medium text-text transition-colors duration-150 hover:bg-button"
              onClick={handleStartLogin}
            >
              Connect Claude Account
            </button>
          </>
        )}

        {/* Awaiting code state */}
        {status === "awaiting_code" && (
          <>
            {!authUrl ? (
              <p className="mb-4 text-center text-[0.929rem] text-text-muted">
                Generating authorization URL...
              </p>
            ) : (
              <>
                <p className="mb-3 text-[0.929rem] leading-relaxed text-text-muted">
                  1. Open the authorization page and sign in with your Claude account.
                  <br />
                  2. Copy the authorization code and paste it below.
                </p>

                <button
                  className="mb-3 block w-full cursor-pointer rounded-lg border border-border-strong bg-elevated px-3 py-2.5 font-[inherit] text-[0.929rem] font-medium text-text transition-colors duration-150 hover:bg-button"
                  onClick={handleOpenAuthPage}
                >
                  Open Authorization Page
                </button>

                <div className="mb-3 flex gap-2">
                  <input
                    ref={inputRef}
                    type="text"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleSubmitCode();
                    }}
                    placeholder="Paste authorization code here..."
                    className="min-w-0 flex-1 rounded-lg border border-border bg-raised px-3 py-2 font-mono text-[0.857rem] text-text outline-none transition-colors placeholder:text-text-dimmed focus:border-accent"
                    spellCheck={false}
                    disabled={submitting}
                  />
                  <button
                    className="shrink-0 cursor-pointer rounded-lg border-none bg-accent px-4 py-2 text-[0.857rem] font-medium text-white transition-colors hover:not-disabled:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={handleSubmitCode}
                    disabled={submitting || !code.trim()}
                  >
                    {submitting ? "..." : "Submit"}
                  </button>
                </div>
              </>
            )}

            <button
              className="block w-full cursor-pointer rounded-lg border border-border bg-none px-3 py-2 font-[inherit] text-[0.857rem] text-text-muted transition-colors duration-150 hover:bg-hover hover:text-text"
              onClick={() => {
                cancelLogin();
                closeAnthropicAuthModal();
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
              <span className="size-1.5 shrink-0 rounded-full bg-success" />
              <span className="text-[0.929rem] font-medium text-success-light">Connected</span>
              <span className="text-[0.786rem] text-text-muted">
                Claude models are available
              </span>
            </div>

            <p className="mb-4 text-[0.929rem] leading-relaxed text-text-muted">
              Set <code className="rounded-md bg-base px-1.5 py-0.5 text-[0.786rem]">"provider": "anthropic"</code> in your config.json to route messages through Claude.
            </p>

            {wasAuthenticatedOnOpen.current ? (
              <div className="flex gap-2">
                <button
                  className="block flex-1 cursor-pointer rounded-lg border border-border bg-none px-3 py-2.5 font-[inherit] text-[0.929rem] text-text-muted transition-colors duration-150 hover:bg-hover hover:text-text"
                  onClick={closeAnthropicAuthModal}
                >
                  Close
                </button>
                <button
                  className="block flex-1 cursor-pointer rounded-lg border border-error-msg-border bg-none px-3 py-2.5 font-[inherit] text-[0.929rem] text-error-bright transition-colors duration-150 hover:bg-error-msg-bg"
                  onClick={async () => {
                    await logout();
                    closeAnthropicAuthModal();
                  }}
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <button
                className="block w-full cursor-pointer rounded-lg border border-border bg-none px-3 py-2.5 font-[inherit] text-[0.929rem] text-text-muted transition-colors duration-150 hover:bg-hover hover:text-text"
                onClick={closeAnthropicAuthModal}
              >
                Close
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
