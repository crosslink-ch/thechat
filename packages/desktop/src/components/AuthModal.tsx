import { useState, useEffect, useRef, type FormEvent } from "react";

interface AuthModalProps {
  onLogin: (email: string, password: string) => Promise<void>;
  onRegister: (name: string, email: string, password: string) => Promise<string | null>;
  onClose: () => void;
}

export function AuthModal({ onLogin, onRegister, onClose }: AuthModalProps) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    emailRef.current?.focus();
  }, [mode]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

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
    setSubmitting(true);

    try {
      if (mode === "login") {
        await onLogin(email, password);
        onClose();
      } else {
        const message = await onRegister(name, email, password);
        if (message) {
          setSuccess(message);
        } else {
          onClose();
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-overlay" onClick={onClose}>
      <div className="auth-card" onClick={(e) => e.stopPropagation()}>
        <h2 className="auth-title">
          {mode === "login" ? "Log in" : "Create account"}
        </h2>

        <form onSubmit={handleSubmit}>
          {mode === "register" && (
            <input
              className="auth-input"
              type="text"
              placeholder="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          )}
          <input
            ref={emailRef}
            className="auth-input"
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <input
            className="auth-input"
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={mode === "register" ? 8 : 1}
          />

          {error && <div className="auth-error">{error}</div>}
          {success && <div className="auth-success">{success}</div>}

          <button className="auth-submit" type="submit" disabled={submitting}>
            {submitting
              ? "..."
              : mode === "login"
                ? "Log in"
                : "Register"}
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
