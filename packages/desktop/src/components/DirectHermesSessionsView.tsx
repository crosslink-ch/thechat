import { useQuery } from "@tanstack/react-query";
import type { HermesRpcSessionsResponse } from "@thechat/shared";
import { api } from "../lib/api";
import { authHeaders, edenErrorMessage } from "../lib/eden";

export function DirectHermesSessionsView({
  botId,
  botName,
  token,
}: {
  botId: string;
  botName: string;
  token: string | null;
}) {
  const query = useQuery({
    queryKey: ["direct-hermes-sessions", botId],
    enabled: !!token,
    queryFn: async () => {
      const { data, error } = await api
        .bots({ botId })["hermes-rpc"]
        .sessions.get(authHeaders(token!));
      if (error) {
        throw new Error(
          edenErrorMessage(error, "Hermes sessions are unavailable"),
        );
      }
      return data as HermesRpcSessionsResponse;
    },
    staleTime: 0,
    refetchOnWindowFocus: false,
  });

  const sessions = query.data?.sessions ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-base">
      <header className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
        <div>
          <h1 className="text-[1rem] font-semibold text-text">
            {botName} · Direct Hermes
          </h1>
          <p className="mt-1 text-[0.786rem] text-text-dimmed">
            Raw session.list response proxied through TheChat
          </p>
        </div>
        <button
          type="button"
          onClick={() => void query.refetch()}
          disabled={query.isFetching || !token}
          className="cursor-pointer rounded-md border border-border bg-raised px-3 py-1.5 text-[0.786rem] font-medium text-text-secondary hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {query.isFetching ? "Loading..." : "Refresh"}
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {!token ? (
          <p role="alert" className="text-error-bright">
            Sign in to list Hermes sessions.
          </p>
        ) : query.isLoading ? (
          <p className="text-text-muted">Calling session.list...</p>
        ) : query.error ? (
          <div role="alert" className="rounded-lg border border-error-msg-border bg-error-msg-bg p-3 text-error-bright">
            {query.error instanceof Error
              ? query.error.message
              : "Hermes sessions are unavailable"}
          </div>
        ) : sessions.length === 0 ? (
          <p className="text-text-muted">Hermes returned no saved sessions.</p>
        ) : (
          <div className="space-y-2">
            {sessions.map((session) => (
              <article
                key={session.id}
                className="rounded-lg border border-border bg-surface p-3"
              >
                <h2 className="font-medium text-text">
                  {session.title || "Untitled Hermes session"}
                </h2>
                <div className="mt-1 break-all font-mono text-[0.714rem] text-text-dimmed">
                  {session.id}
                </div>
                {session.preview && (
                  <p className="mt-2 whitespace-pre-wrap text-[0.857rem] leading-relaxed text-text-muted">
                    {session.preview}
                  </p>
                )}
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[0.714rem] text-text-dimmed">
                  <span>{session.messageCount} messages</span>
                  {session.source && <span>source: {session.source}</span>}
                  {session.startedAt > 0 && (
                    <span>{formatHermesTimestamp(session.startedAt)}</span>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function formatHermesTimestamp(value: number) {
  const milliseconds = value > 10_000_000_000 ? value : value * 1_000;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}
