import { useState, useEffect, useRef, type FormEvent } from "react";
import { create } from "zustand";
import { z } from "zod";
import { useAuthStore } from "../stores/auth";

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

function AuthModalInner() {
  const login = useAuthStore((s) => s.login);
  const register = useAuthStore((s) => s.register);

  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [submitting, setSubmitting] = useState(false);
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

  const reset = () => {
    setError("");
    setSuccess("");
  };

  const switchMode = (newMode: "login" | "register") => {
    setMode(newMode);
    setName("");
    setEmail("");
    setPassword("");
    reset();
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    reset();

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
          setSuccess(message);
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

  return (
    <div className="auth-overlay" onClick={closeAuthModal}>
      <div className="auth-card" onClick={(e) => e.stopPropagation()}>
        <h2 className="auth-title">
          {mode === "login" ? "Log in" : "Create account"}
        </h2>

        <form onSubmit={handleSubmit} noValidate>
          {mode === "register" && (
            <div className="auth-field">
              <label className="auth-label" htmlFor="auth-name">
                Name
              </label>
              <input
                ref={mode === "register" ? firstInputRef : undefined}
                id="auth-name"
                className="auth-input"
                type="text"
                placeholder="John Doe"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          )}
          <div className="auth-field">
            <label className="auth-label" htmlFor="auth-email">
              Email
            </label>
            <input
              ref={mode === "login" ? firstInputRef : undefined}
              id="auth-email"
              className="auth-input"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="auth-field">
            <label className="auth-label" htmlFor="auth-password">
              Password
            </label>
            <input
              id="auth-password"
              className="auth-input"
              type="password"
              placeholder={mode === "register" ? "At least 8 characters" : ""}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error && <div className="auth-error">{error}</div>}
          {success && <div className="auth-success">{success}</div>}

          <button className="auth-submit" type="submit" disabled={submitting}>
            {submitting
              ? "..."
              : mode === "login"
                ? "Log in"
                : "Create account"}
          </button>
        </form>

        <div className="auth-switch">
          {mode === "login" ? (
            <>
              Don't have an account?{" "}
              <button onClick={() => switchMode("register")}>Register</button>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <button onClick={() => switchMode("login")}>Log in</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
