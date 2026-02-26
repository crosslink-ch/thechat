import { useState, useEffect, useRef, useCallback, type FormEvent } from "react";
import { create } from "zustand";
import { z } from "zod";
import { useAuthStore } from "../stores/auth";
import { api } from "../lib/api";

// Colocated visibility store
const useAuthModalState = create(() => ({ open: false }));
export const openAuthModal = () => useAuthModalState.setState({ open: true });
const closeAuthModal = () => useAuthModalState.setState({ open: false });

const registerSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  email: z.email("Please enter a valid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

const loginSchema = z.object({
  email: z.email("Please enter a valid email address"),
  password: z.string().min(1, "Password is required"),
});

export function AuthModal() {
  const open = useAuthModalState((s) => s.open);
  if (!open) return null;
  return <AuthModalInner />;
}

function ResendButton({ email }: { email: string }) {
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const handleResend = useCallback(async () => {
    if (state === "sending" || cooldown > 0) return;
    setState("sending");
    try {
      await api.auth["resend-verification"].post({ email });
      setState("sent");
      setCooldown(60);
    } catch {
      setState("idle");
    }
  }, [email, state, cooldown]);

  return (
    <button
      className="cursor-pointer border-none bg-none p-0 font-[inherit] text-[13px] text-accent underline transition-colors duration-150 hover:text-text disabled:cursor-default disabled:opacity-40 disabled:no-underline"
      onClick={handleResend}
      disabled={state === "sending" || cooldown > 0}
    >
      {state === "sending"
        ? "Sending..."
        : cooldown > 0
          ? `Resend in ${cooldown}s`
          : "Resend verification email"}
    </button>
  );
}

function VerificationPendingView({ email, onBackToLogin }: { email: string; onBackToLogin: () => void }) {
  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-overlay backdrop-blur-[2px] animate-fade-in" onClick={closeAuthModal}>
      <div className="w-full max-w-[400px] rounded-xl border border-border-strong bg-surface p-6 shadow-card animate-slide-up" onClick={(e) => e.stopPropagation()}>
        <div className="flex flex-col items-center text-center">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mb-4 h-12 w-12 text-accent">
            <rect x="2" y="4" width="20" height="16" rx="2" />
            <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
          </svg>

          <h2 className="mb-2 text-[17px] font-semibold tracking-tight text-text">
            Check your email
          </h2>
          <p className="mb-5 text-[13px] leading-relaxed text-text-muted">
            We sent a verification link to{" "}
            <span className="font-medium text-text">{email}</span>
          </p>

          <ResendButton email={email} />

          <button
            className="mt-4 cursor-pointer border-none bg-none p-0 font-[inherit] text-[12px] text-text-muted underline transition-colors duration-150 hover:text-text"
            onClick={onBackToLogin}
          >
            Back to login
          </button>
        </div>
      </div>
    </div>
  );
}

function AuthModalInner() {
  const login = useAuthStore((s) => s.login);
  const register = useAuthStore((s) => s.register);

  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [verificationEmail, setVerificationEmail] = useState<string | null>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstInputRef.current?.focus();
  }, [mode]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeAuthModal();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  const switchMode = (newMode: "login" | "register") => {
    setMode(newMode);
    setName("");
    setEmail("");
    setPassword("");
    setError("");
    setVerificationEmail(null);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");

    const parsed =
      mode === "register"
        ? registerSchema.safeParse({ name, email, password })
        : loginSchema.safeParse({ email, password });

    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid input");
      return;
    }

    setSubmitting(true);

    try {
      if (mode === "login") {
        const data = parsed.data as z.infer<typeof loginSchema>;
        await login(data.email, data.password);
        closeAuthModal();
      } else {
        const data = parsed.data as z.infer<typeof registerSchema>;
        const message = await register(data.name, data.email, data.password);
        if (message) {
          setVerificationEmail(data.email);
        } else {
          closeAuthModal();
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  };

  if (verificationEmail) {
    return (
      <VerificationPendingView
        email={verificationEmail}
        onBackToLogin={() => switchMode("login")}
      />
    );
  }

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-overlay backdrop-blur-[2px] animate-fade-in" onClick={closeAuthModal}>
      <div className="w-full max-w-[400px] rounded-xl border border-border-strong bg-surface p-6 shadow-card animate-slide-up" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-5 text-[17px] font-semibold tracking-tight text-text">
          {mode === "login" ? "Log in" : "Create account"}
        </h2>

        <form onSubmit={handleSubmit} noValidate>
          {mode === "register" && (
            <div className="mb-3.5">
              <label className="mb-1.5 block text-[12px] font-medium text-text-muted" htmlFor="auth-name">
                Name
              </label>
              <input
                ref={mode === "register" ? firstInputRef : undefined}
                id="auth-name"
                className="block w-full rounded-lg border border-border bg-base px-3.5 py-2.5 font-[inherit] text-[13px] text-text outline-none transition-colors duration-150 placeholder:text-text-placeholder focus:border-border-focus"
                type="text"
                placeholder="John Doe"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          )}
          <div className="mb-3.5">
            <label className="mb-1.5 block text-[12px] font-medium text-text-muted" htmlFor="auth-email">
              Email
            </label>
            <input
              ref={mode === "login" ? firstInputRef : undefined}
              id="auth-email"
              className="block w-full rounded-lg border border-border bg-base px-3.5 py-2.5 font-[inherit] text-[13px] text-text outline-none transition-colors duration-150 placeholder:text-text-placeholder focus:border-border-focus"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="mb-3.5">
            <label className="mb-1.5 block text-[12px] font-medium text-text-muted" htmlFor="auth-password">
              Password
            </label>
            <input
              id="auth-password"
              className="block w-full rounded-lg border border-border bg-base px-3.5 py-2.5 font-[inherit] text-[13px] text-text outline-none transition-colors duration-150 placeholder:text-text-placeholder focus:border-border-focus"
              type="password"
              placeholder={mode === "register" ? "At least 8 characters" : ""}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error && <div className="mb-3 rounded-lg border border-error-msg-border bg-error-msg-bg px-3 py-2 text-[12px] text-error-bright">{error}</div>}

          <button
            className="mt-1 block w-full cursor-pointer rounded-lg border border-border-strong bg-elevated px-3 py-2.5 font-[inherit] text-[13px] font-medium text-text transition-colors duration-150 hover:not-disabled:bg-button disabled:cursor-default disabled:opacity-40"
            type="submit"
            disabled={submitting}
          >
            {submitting
              ? "..."
              : mode === "login"
                ? "Log in"
                : "Create account"}
          </button>
        </form>

        <div className="mt-4 text-center text-[12px] text-text-muted">
          {mode === "login" ? (
            <>
              Don't have an account?{" "}
              <button className="cursor-pointer border-none bg-none p-0 font-[inherit] text-[12px] text-accent underline transition-colors duration-150 hover:text-text" onClick={() => switchMode("register")}>Register</button>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <button className="cursor-pointer border-none bg-none p-0 font-[inherit] text-[12px] text-accent underline transition-colors duration-150 hover:text-text" onClick={() => switchMode("login")}>Log in</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
