import { authHeaders as auth } from "../lib/eden";
import { isAuthenticated } from "../lib/auth-identity";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { API_URL, api } from "../lib/api";
import { edenErrorMessage } from "../lib/eden";
import { useAuthStore } from "../stores/auth";
import {
  SettingsSection,
  settingsCard,
  settingsDangerButton,
  settingsInput,
  settingsLabel,
  settingsPrimaryButton,
  settingsQuietButton,
  settingsRow,
  settingsSecondaryButton,
  settingsValue,
} from "../components/SettingsSection";

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
      className={settingsSecondaryButton}
      aria-label={`Copy ${label}`}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function ClientExample({
  title,
  hint,
  snippet,
  copyLabel,
  copied,
  onCopy,
  wrap = false,
}: {
  title: string;
  hint: string;
  snippet: string;
  copyLabel: string;
  copied: boolean;
  onCopy: () => void;
  /** Wrap single-line commands; structured snippets keep their layout and scroll. */
  wrap?: boolean;
}) {
  return (
    <div className={settingsRow}>
      <h3 className={settingsLabel}>{title}</h3>
      <div className="min-w-0">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[0.786rem] leading-5 text-text-dimmed">{hint}</p>
          <CopyButton label={copyLabel} copied={copied} onCopy={onCopy} />
        </div>
        <pre
          className={`mt-2 max-w-full rounded-lg border border-border bg-base px-3 py-2.5 font-mono text-[0.857rem] leading-6 text-text-secondary ${
            wrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "overflow-x-auto"
          }`}
        >
          <code>{snippet}</code>
        </pre>
      </div>
    </div>
  );
}

export function ApiAccessSettings() {
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
    if (!isAuthenticated(sessionToken)) {
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
    if (!isAuthenticated(sessionToken) || !trimmedName || creating || loading) return;

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
    if (!isAuthenticated(sessionToken) || revokingId) return;
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
    <SettingsSection
      id="api-access-heading"
      title="API access"
      description="Named, non-expiring tokens for TheChat REST and MCP clients. A token carries your full user access, so create one only for clients you trust."
    >
      <div className={settingsCard}>
        {notice && (
          <div
            role={notice.kind === "error" ? "alert" : "status"}
            className={`px-4 py-3 text-[0.857rem] leading-5 sm:px-5 ${
              notice.kind === "error"
                ? "bg-error-msg-bg text-error-bright"
                : "bg-success-bg text-success-light"
            }`}
          >
            {notice.message}
          </div>
        )}

        <form
          aria-label="Create personal access token"
          onSubmit={createToken}
          className={settingsRow}
        >
          <div className="min-w-0">
            <label
              htmlFor="personal-access-token-name"
              className={`block ${settingsLabel}`}
            >
              Token name
            </label>
          </div>
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
            <input
              id="personal-access-token-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Local automation"
              maxLength={100}
              required
              disabled={creating}
              className={`${settingsInput} sm:flex-1`}
            />
            <button
              type="submit"
              disabled={!name.trim() || creating || loading || !isAuthenticated(sessionToken)}
              className={settingsPrimaryButton}
            >
              {creating ? "Creating..." : "Create token"}
            </button>
          </div>
        </form>

        {revealed && (
          <div className="bg-warning-bg px-4 py-4 sm:px-5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <h3 className="break-words text-[0.857rem] font-semibold leading-5 text-warning-text">
                  Copy {revealed.name} now
                </h3>
                <p className="mt-0.5 text-[0.786rem] leading-5 text-text-muted">
                  This is the only time TheChat will return the complete token.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setRevealed(null)}
                className={settingsQuietButton}
              >
                Hide token
              </button>
            </div>
            <div className="mt-3 flex min-w-0 gap-2">
              <input
                aria-label="New personal access token"
                readOnly
                value={revealed.value}
                className="h-10 min-w-0 flex-1 rounded-lg border border-border bg-base px-3 font-mono text-[0.857rem] text-text outline-none focus-visible:ring-2 focus-visible:ring-accent/30 max-sm:h-[44px]"
              />
              <CopyButton
                label="personal access token"
                copied={copied === "token"}
                onCopy={() => void copy("token", revealed.value)}
              />
            </div>
          </div>
        )}

        {loading ? (
          <p className={`px-4 py-4 sm:px-5 ${settingsValue}`}>Loading tokens...</p>
        ) : tokens.length === 0 ? (
          <p className={`px-4 py-4 sm:px-5 ${settingsValue}`}>
            No personal access tokens yet.
          </p>
        ) : (
          <ul
            className="divide-y divide-border-subtle"
            aria-label="Personal access tokens"
          >
            {tokens.map((item) => (
              <li
                key={item.id}
                aria-label={`${item.name} personal access token`}
                className="flex min-w-0 flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6 sm:px-5"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="min-w-0 max-w-full truncate text-[0.857rem] font-medium leading-5 text-text">
                      {item.name}
                    </span>
                    <code className="font-mono text-[0.786rem] leading-5 text-text-dimmed">
                      {item.start ? `${item.start}…` : "Identifier unavailable"}
                    </code>
                  </div>
                  <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[0.786rem] leading-5 text-text-muted">
                    <div className="flex gap-1.5">
                      <dt className="text-text-dimmed">Created</dt>
                      <dd>
                        <time dateTime={item.createdAt}>
                          {formatDate(item.createdAt)}
                        </time>
                      </dd>
                    </div>
                    <div className="flex gap-1.5">
                      <dt className="text-text-dimmed">Last used</dt>
                      <dd>
                        {item.lastUsedAt ? (
                          <time dateTime={item.lastUsedAt}>
                            {formatDate(item.lastUsedAt)}
                          </time>
                        ) : (
                          "Never"
                        )}
                      </dd>
                    </div>
                  </dl>
                </div>
                <div className="flex shrink-0 items-center gap-2 sm:justify-end">
                  {confirmingId === item.id && (
                    <button
                      type="button"
                      onClick={() => setConfirmingId(null)}
                      className={settingsQuietButton}
                    >
                      Cancel
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void revokeToken(item.id)}
                    disabled={revokingId !== null}
                    className={
                      confirmingId === item.id
                        ? settingsDangerButton
                        : settingsSecondaryButton
                    }
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

      <div className={settingsCard}>
        <ClientExample
          title="REST"
          hint="Authenticate with a Bearer token."
          snippet={restSnippet}
          copyLabel="REST curl snippet"
          copied={copied === "rest"}
          onCopy={() => void copy("rest", restSnippet)}
          wrap
        />
        <ClientExample
          title="MCP"
          hint="Add this Streamable HTTP server to your client."
          snippet={mcpSnippet}
          copyLabel="MCP JSON snippet"
          copied={copied === "mcp"}
          onCopy={() => void copy("mcp", mcpSnippet)}
        />
      </div>
    </SettingsSection>
  );
}
