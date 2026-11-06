import type { MessageContext, MessageSearchPage, SearchDestination } from "@thechat/shared";
import { api } from "./api";
import { authHeaders, edenErrorMessage, edenErrorStatus } from "./eden";
import { useAuthStore } from "../stores/auth";

/** A failed search request, with the HTTP status when there was one. */
export class SearchRequestError extends Error {
  constructor(message: string, readonly status: number | undefined) {
    super(message);
  }
}

function request(signal?: AbortSignal) {
  return { ...authHeaders(useAuthStore.getState().token), ...(signal ? { fetch: { signal } } : {}) };
}

function fail(error: unknown, fallback: string): never {
  throw new SearchRequestError(edenErrorMessage(error, fallback), edenErrorStatus(error));
}

/** Every channel, person and recent task the user can open, in all workspaces. */
export async function fetchSearchDirectory(signal?: AbortSignal): Promise<SearchDestination[]> {
  const { data, error } = await api.search.directory.get(request(signal));
  if (error) fail(error, "Could not load conversations");
  return (data as unknown as { destinations: SearchDestination[] }).destinations;
}

/** Server-side name lookup: reaches tasks older than the cached directory holds. */
export async function fetchDestinations(
  params: { q: string; kinds?: SearchDestination["kind"][]; limit?: number },
  signal?: AbortSignal,
): Promise<SearchDestination[]> {
  const query: Record<string, string | number> = { q: params.q };
  if (params.kinds?.length) query.kinds = params.kinds.join(",");
  if (params.limit) query.limit = params.limit;
  const { data, error } = await api.search.destinations.get({ query, ...request(signal) });
  if (error) fail(error, "Could not search conversations");
  return (data as unknown as { destinations: SearchDestination[] }).destinations;
}

export interface MessageSearchParams {
  q: string;
  workspaceId?: string;
  conversationId?: string;
  threadId?: string;
  senderId?: string;
  cursor?: string;
  limit?: number;
}

export async function fetchMessageSearch(
  params: MessageSearchParams,
  signal?: AbortSignal,
): Promise<MessageSearchPage> {
  const query: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") query[key] = value;
  }
  const { data, error } = await api.search.messages.get({ query, ...request(signal) });
  if (error) fail(error, "Search failed");
  return data as unknown as MessageSearchPage;
}

export async function fetchMessageContext(
  messageId: string,
  options: { before?: number; after?: number } = {},
  signal?: AbortSignal,
): Promise<MessageContext> {
  const query: Record<string, number> = {};
  if (options.before !== undefined) query.before = options.before;
  if (options.after !== undefined) query.after = options.after;
  const { data, error } = await api.search
    .messages({ messageId })
    .context.get({ query, ...request(signal) });
  if (error) fail(error, "Could not load this message");
  return data as unknown as MessageContext;
}

/** The DM with `otherUserId`, created on first use. */
export async function openDirectConversationId(workspaceId: string, otherUserId: string) {
  const { data, error } = await api.conversations.dm.post(
    { workspaceId, otherUserId },
    authHeaders(useAuthStore.getState().token),
  );
  if (error) fail(error, "Could not open the conversation");
  const id = (data as { id?: string } | null)?.id;
  if (!id) throw new SearchRequestError("Could not open the conversation", undefined);
  return id;
}
