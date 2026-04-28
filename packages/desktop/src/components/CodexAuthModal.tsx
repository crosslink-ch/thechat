import { useEffect, useRef } from "react";
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
  const browserAuthUrl = useCodexAuthStore((s) => s.browserAuthUrl);
  const error = useCodexAuthStore((s) => s.error);
  const startLogin = useCodexAuthStore((s) => s.startLogin);
  const cancelLogin = useCodexAuthStore((s) => s.cancelLogin);
  const logout = useCodexAuthStore((s) => s.logout);

  // Track whether user was already authenticated when the modal opened
  const wasAuthenticatedOnOpen = useRef(status === "authenticated");

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (status === "polling" || status === "awaiting_code" || status === "opening_browser" || status === "waiting_browser") {
          cancelLogin();
        }
        closeCodexAuthModal();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [status, cancelLogin]);

  const handleStartLogin = () => {
    startLogin("browser");
  };

  const handleStartDeviceLogin = () => {
    startLogin("device");
  };

  const handleOpenVerification = () => {
    openUrl(verificationUrl);
  };

  const handleReopenBrowserLogin = () => {
    if (browserAuthUrl) openUrl(browserAuthUrl);
  };

  const handleCopyCode = () => {
    if (userCode) {
      navigator.clipboard.writeText(userCode);
    }
  };

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-overlay backdrop-blur-[2px] animate-fade-in" onClick={closeCodexAuthModal}>
      <div className="w-full max-w-[420px] rounded-xl border border-border-strong bg-surface p-6 shadow-card animate-slide-up" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-5 text-[1.214rem] font-semibold tracking-tight text-text">
          ChatGPT Pro/Plus
        </h2>

        {/* Idle / Not connected state */}
        {(status === "idle" || status === "error") && (
          <>
            <p className="mb-4 text-[0.929rem] leading-relaxed text-text-muted">
              Connect your ChatGPT Pro or Plus subscription to use Codex models for free.
              Browser login is recommended, with device code available as a fallback.
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
              Continue in Browser
            </button>

            <button
              className="mt-2 block w-full cursor-pointer rounded-lg border border-border bg-none px-3 py-2.5 font-[inherit] text-[0.929rem] text-text-muted transition-colors duration-150 hover:bg-hover hover:text-text"
              onClick={handleStartDeviceLogin}
            >
              Use Device Code Instead
            </button>
          </>
        )}

        {/* Browser login state */}
        {(status === "opening_browser" || status === "waiting_browser") && (
          <>
            <p className="mb-4 text-[0.929rem] leading-relaxed text-text-muted">
              {status === "opening_browser"
                ? "Preparing secure browser login..."
                : "Finish signing in with ChatGPT in your browser. TheChat will continue automatically when OpenAI redirects back."}
            </p>

            {browserAuthUrl && (
              <button
                className="mb-3 block w-full cursor-pointer rounded-lg border border-border-strong bg-elevated px-3 py-2.5 font-[inherit] text-[0.929rem] font-medium text-text transition-colors duration-150 hover:bg-button"
                onClick={handleReopenBrowserLogin}
              >
                Reopen Browser Login
              </button>
            )}

            <button
              className="mb-2 block w-full cursor-pointer rounded-lg border border-border bg-none px-3 py-2 font-[inherit] text-[0.857rem] text-text-muted transition-colors duration-150 hover:bg-hover hover:text-text"
              onClick={handleStartDeviceLogin}
            >
              Use Device Code Instead
            </button>

            <button
              className="block w-full cursor-pointer rounded-lg border border-border bg-none px-3 py-2 font-[inherit] text-[0.857rem] text-text-muted transition-colors duration-150 hover:bg-hover hover:text-text"
              onClick={() => {
                cancelLogin();
                closeCodexAuthModal();
              }}
            >
              Cancel
            </button>
          </>
        )}

        {/* Awaiting code / Polling state */}
        {(status === "awaiting_code" || status === "polling") && (
          <>
            {!userCode ? (
              <p className="mb-4 text-center text-[0.929rem] text-text-muted">
                Generating device code...
              </p>
            ) : (
              <>
                <p className="mb-3 text-[0.929rem] leading-relaxed text-text-muted">
                  Enter this code at the OpenAI verification page:
                </p>

                <button
                  className="mx-auto mb-4 flex cursor-pointer items-center gap-2 rounded-lg border border-border-strong bg-base px-6 py-3 font-mono text-2xl font-bold tracking-[0.15em] text-text transition-colors duration-150 hover:bg-hover"
                  onClick={handleCopyCode}
                  title="Click to copy"
                >
                  {userCode}
                  <span className="text-[0.714rem] font-normal tracking-normal text-text-dimmed">copy</span>
                </button>

                <button
                  className="mb-3 block w-full cursor-pointer rounded-lg border border-border-strong bg-elevated px-3 py-2.5 font-[inherit] text-[0.929rem] font-medium text-text transition-colors duration-150 hover:bg-button"
                  onClick={handleOpenVerification}
                >
                  Open Verification Page
                </button>

                <p className="mb-4 text-center text-[0.786rem] text-text-dimmed">
                  Waiting for authorization...
                </p>
              </>
            )}

            <button
              className="block w-full cursor-pointer rounded-lg border border-border bg-none px-3 py-2 font-[inherit] text-[0.857rem] text-text-muted transition-colors duration-150 hover:bg-hover hover:text-text"
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
              <span className="size-1.5 shrink-0 rounded-full bg-success" />
              <span className="text-[0.929rem] font-medium text-success-light">Connected</span>
              <span className="text-[0.786rem] text-text-muted">
                Codex models are available
              </span>
            </div>

            <p className="mb-4 text-[0.929rem] leading-relaxed text-text-muted">
              Set <code className="rounded-md bg-base px-1.5 py-0.5 text-[0.786rem]">"provider": "codex"</code> in your config.json to route messages through Codex.
            </p>

            {wasAuthenticatedOnOpen.current ? (
              <div className="flex gap-2">
                <button
                  className="block flex-1 cursor-pointer rounded-lg border border-border bg-none px-3 py-2.5 font-[inherit] text-[0.929rem] text-text-muted transition-colors duration-150 hover:bg-hover hover:text-text"
                  onClick={closeCodexAuthModal}
                >
                  Close
                </button>
                <button
                  className="block flex-1 cursor-pointer rounded-lg border border-error-msg-border bg-none px-3 py-2.5 font-[inherit] text-[0.929rem] text-error-bright transition-colors duration-150 hover:bg-error-msg-bg"
                  onClick={async () => {
                    await logout();
                    closeCodexAuthModal();
                  }}
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <button
                className="block w-full cursor-pointer rounded-lg border border-border bg-none px-3 py-2.5 font-[inherit] text-[0.929rem] text-text-muted transition-colors duration-150 hover:bg-hover hover:text-text"
                onClick={closeCodexAuthModal}
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
