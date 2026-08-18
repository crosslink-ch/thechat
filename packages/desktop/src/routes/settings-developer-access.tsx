import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { API_URL, api } from "../lib/api";
import { edenErrorMessage } from "../lib/eden";
import { useAuthStore } from "../stores/auth";

type PersonalAccessToken = {
  id: string;
  name: string;
  start: string | null;
  createdAt: string;
  lastUsedAt: string | null;
};

type RevealedToken = {
  id: string;
  name: string;
  value: string;
};

type Notice = { kind: "success" | "error"; message: string } | null;

function auth(token: string) {
  return { headers: { authorization: `Bearer ${token}` } };
}

function formatDate(value: string | null) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function CopyButton({
  label,
  copied,
  onCopy,
}: {
  label: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onCopy}
      className="shrink-0 cursor-pointer rounded-md border border-border bg-raised px-3 py-1.5 text-[0.786rem] font-medium text-text-muted transition-colors hover:bg-hover hover:text-text"
      aria-label={`Copy ${label}`}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export function DeveloperAccessSettings() {
  const sessionToken = useAuthStore((state) => state.token);
  const [tokens, setTokens] = useState<PersonalAccessToken[]>([]);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<RevealedToken | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const loadTokens = useCallback(async () => {
    if (!sessionToken) {
      setTokens([]);
      setLoading(false);
      return;
    }

    try {
      const { data, error } = await api.auth["personal-access-tokens"].get(
        auth(sessionToken),
      );
      if (error) {
        throw new Error(
          edenErrorMessage(error, "Could not load personal access tokens"),
        );
      }
      const values =
        data &&
        "personalAccessTokens" in data &&
        Array.isArray(data.personalAccessTokens)
          ? data.personalAccessTokens
          : [];
      setTokens(values as PersonalAccessToken[]);
      setNotice(null);
    } catch (error) {
      setNotice({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "Could not load personal access tokens",
      });
    } finally {
      setLoading(false);
    }
  }, [sessionToken]);

  useEffect(() => {
    void loadTokens();
  }, [loadTokens]);

  const createToken = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!sessionToken || !trimmedName || creating || loading) return;

    setCreating(true);
    setNotice(null);
    setRevealed(null);
    try {
      const { data, error } = await api.auth["personal-access-tokens"].post(
        { name: trimmedName },
        auth(sessionToken),
      );
      if (error) {
        throw new Error(
          edenErrorMessage(error, "Could not create personal access token"),
        );
      }
      if (
        !data ||
        !("token" in data) ||
        typeof data.token !== "string" ||
        !("personalAccessToken" in data) ||
        !data.personalAccessToken
      ) {
        throw new Error("The API returned no personal access token");
      }

      const metadata = data.personalAccessToken as PersonalAccessToken;
      setTokens((current) => [
        metadata,
        ...current.filter((item) => item.id !== metadata.id),
      ]);
      setRevealed({
        id: metadata.id,
        name: metadata.name,
        value: data.token,
      });
      setName("");
      setNotice({
        kind: "success",
        message: "Personal access token created. Copy it before leaving this page.",
      });
    } catch (error) {
      setNotice({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "Could not create personal access token",
      });
    } finally {
      setCreating(false);
    }
  };

  const revokeToken = async (tokenId: string) => {
    if (!sessionToken || revokingId) return;
    if (confirmingId !== tokenId) {
      setConfirmingId(tokenId);
      return;
    }

    setRevokingId(tokenId);
    setNotice(null);
    try {
      const { error } = await api.auth["personal-access-tokens"]({
        tokenId,
      }).delete(undefined, auth(sessionToken));
      if (error) {
        throw new Error(
          edenErrorMessage(error, "Could not revoke personal access token"),
        );
      }
      setTokens((current) => current.filter((item) => item.id !== tokenId));
      setRevealed((current) => (current?.id === tokenId ? null : current));
      setConfirmingId(null);
      setNotice({ kind: "success", message: "Personal access token revoked." });
    } catch (error) {
      setNotice({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "Could not revoke personal access token",
      });
    } finally {
      setRevokingId(null);
    }
  };

  const copy = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(
        () => setCopied((current) => (current === key ? null : current)),
        1500,
      );
    } catch {
      setNotice({
        kind: "error",
        message: "Could not copy to the clipboard.",
      });
    }
  };

  const baseUrl = API_URL.replace(/\/+$/, "");
  const exampleToken = revealed?.value ?? "<YOUR_PERSONAL_ACCESS_TOKEN>";
  const restSnippet = useMemo(
    () =>
      `curl --request GET '${baseUrl}/auth/me' --header 'Authorization: Bearer ${exampleToken}'`,
    [baseUrl, exampleToken],
  );
  const mcpSnippet = useMemo(
    () =>
      JSON.stringify(
        {
          mcpServers: {
            thechat: {
              url: `${baseUrl}/mcp`,
              headers: {
                Authorization: `Bearer ${exampleToken}`,
              },
            },
          },
        },
        null,
        2,
      ),
    [baseUrl, exampleToken],
  );

  return (
    <section
      className="overflow-hidden rounded-xl border border-border-subtle bg-surface shadow-sm"
      aria-labelledby="developer-access-heading"
    >
      <div className="border-b border-border-subtle p-5 sm:p-6">
        <div className="text-[0.714rem] font-semibold uppercase tracking-[0.16em] text-accent">
          Developer
        </div>
        <h2
          id="developer-access-heading"
          className="mt-1 text-[1.214rem] font-semibold tracking-[-0.02em] text-text"
        >
          Developer access
        </h2>
        <p className="mt-2 max-w-[600px] text-[0.857rem] leading-5 text-text-muted">
          Create named, non-expiring credentials for TheChat REST and MCP clients.
          Tokens carry your full user access. Only create them for clients you
          trust.
        </p>
      </div>

      <div className="space-y-5 p-5 sm:p-6">
        <div className="rounded-lg border border-amber-400/30 bg-amber-400/10 p-3.5 text-[0.786rem] leading-5 text-amber-200">
          Store tokens in a password manager or secret store. Never commit them,
          paste them into chat, or include them in logs. A lost token cannot be
          recovered; revoke it and create a replacement.
        </div>

        {notice && (
          <div
            role={notice.kind === "error" ? "alert" : "status"}
            className={`rounded-lg border px-3.5 py-2.5 text-[0.786rem] ${
              notice.kind === "error"
                ? "border-error-msg-border bg-error-msg-bg text-error-bright"
                : "border-green-500/30 bg-green-500/10 text-green-400"
            }`}
          >
            {notice.message}
          </div>
        )}

        <form
          aria-label="Create personal access token"
          onSubmit={createToken}
          className="rounded-lg border border-border-subtle bg-base/60 p-4"
        >
          <label
            htmlFor="personal-access-token-name"
            className="text-[0.786rem] font-medium text-text-muted"
          >
            Token name
          </label>
          <div className="mt-2 flex min-w-0 flex-col gap-2 sm:flex-row">
            <input
              id="personal-access-token-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Local automation"
              maxLength={100}
              required
              disabled={creating}
              className="h-10 min-w-0 flex-1 rounded-lg border border-border-subtle bg-base px-3 text-[0.857rem] text-text outline-none transition-colors placeholder:text-text-placeholder focus:border-accent disabled:cursor-wait disabled:opacity-70"
            />
            <button
              type="submit"
              disabled={!name.trim() || creating || loading || !sessionToken}
              className="inline-flex h-10 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-accent px-4 text-[0.857rem] font-semibold text-white transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-45"
            >
              {creating ? "Creating..." : "Create token"}
            </button>
          </div>
        </form>

        {revealed && (
          <div className="rounded-lg border border-amber-400/40 bg-amber-400/10 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-[0.857rem] font-semibold text-amber-200">
                  Copy {revealed.name} now
                </h3>
                <p className="mt-1 text-[0.786rem] leading-5 text-text-muted">
                  This is the only time TheChat will return the complete token.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setRevealed(null)}
                className="cursor-pointer border-none bg-transparent text-[0.786rem] text-text-muted hover:text-text"
              >
                Hide token
              </button>
            </div>
            <div className="mt-3 flex min-w-0 gap-2">
              <input
                aria-label="New personal access token"
                readOnly
                value={revealed.value}
                className="min-w-0 flex-1 rounded-md border border-border bg-base px-2.5 py-2 font-mono text-[0.714rem] text-text outline-none"
              />
              <CopyButton
                label="personal access token"
                copied={copied === "token"}
                onCopy={() => void copy("token", revealed.value)}
              />
            </div>
          </div>
        )}

        <div>
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="text-[0.929rem] font-semibold text-text">
              Personal access tokens
            </h3>
            <span className="text-[0.714rem] text-text-dimmed">
              {tokens.length} active
            </span>
          </div>
          {loading ? (
            <div className="rounded-lg border border-border-subtle bg-base/60 px-4 py-5 text-center text-[0.786rem] text-text-muted">
              Loading tokens...
            </div>
          ) : tokens.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border bg-base/40 px-4 py-5 text-center text-[0.786rem] text-text-muted">
              No personal access tokens yet.
            </div>
          ) : (
            <ul className="space-y-2" aria-label="Personal access tokens">
              {tokens.map((item) => (
                <li
                  key={item.id}
                  className="flex min-w-0 flex-col gap-3 rounded-lg border border-border-subtle bg-base/60 p-3.5 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="truncate text-[0.857rem] font-medium text-text">
                      {item.name}
                    </div>
                    <div className="mt-1 break-all font-mono text-[0.714rem] text-text-dimmed">
                      {item.start ? `${item.start}…` : "Identifier unavailable"}
                    </div>
                    <div className="mt-1 text-[0.714rem] text-text-dimmed">
                      Created {formatDate(item.createdAt)} · Last used{" "}
                      {formatDate(item.lastUsedAt)}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {confirmingId === item.id && (
                      <button
                        type="button"
                        onClick={() => setConfirmingId(null)}
                        className="cursor-pointer border-none bg-transparent px-2 py-1.5 text-[0.786rem] text-text-muted hover:text-text"
                      >
                        Cancel
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void revokeToken(item.id)}
                      disabled={revokingId !== null}
                      className="cursor-pointer rounded-md border border-error-msg-border bg-error-msg-bg px-3 py-1.5 text-[0.786rem] font-medium text-error-bright transition-colors hover:not-disabled:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                      aria-label={`Revoke ${item.name}`}
                    >
                      {revokingId === item.id
                        ? "Revoking..."
                        : confirmingId === item.id
                          ? "Confirm revoke"
                          : "Revoke"}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="grid min-w-0 gap-3 lg:grid-cols-2">
          <div className="min-w-0 rounded-lg border border-border-subtle bg-base/60 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-[0.857rem] font-semibold text-text">REST</h3>
                <p className="mt-0.5 text-[0.714rem] text-text-dimmed">
                  Authenticate with a Bearer token.
                </p>
              </div>
              <CopyButton
                label="REST curl snippet"
                copied={copied === "rest"}
                onCopy={() => void copy("rest", restSnippet)}
              />
            </div>
            <pre className="mt-3 max-w-full overflow-x-auto rounded-md border border-border bg-base p-3 text-[0.714rem] leading-5 text-text-muted">
              <code>{restSnippet}</code>
            </pre>
          </div>

          <div className="min-w-0 rounded-lg border border-border-subtle bg-base/60 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-[0.857rem] font-semibold text-text">MCP</h3>
                <p className="mt-0.5 text-[0.714rem] text-text-dimmed">
                  Add this Streamable HTTP server to your client.
                </p>
              </div>
              <CopyButton
                label="MCP JSON snippet"
                copied={copied === "mcp"}
                onCopy={() => void copy("mcp", mcpSnippet)}
              />
            </div>
            <pre className="mt-3 max-w-full overflow-x-auto rounded-md border border-border bg-base p-3 text-[0.714rem] leading-5 text-text-muted">
              <code>{mcpSnippet}</code>
            </pre>
          </div>
        </div>

        <p className="text-[0.786rem] leading-5 text-text-dimmed">
          Revocation takes effect immediately for future REST and MCP requests.
        </p>
      </div>
    </section>
  );
}
