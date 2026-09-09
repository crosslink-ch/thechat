import type { SearchDestination, SearchMessageResult, SearchPage } from "@thechat/shared";
import { api } from "./api";
import { authHeaders, edenErrorMessage } from "./eden";
import type { DestinationKind } from "./search";

export async function searchJump(
  query: {
    q: string;
    kind: DestinationKind;
    workspaceId?: string;
    recentIds?: string;
    limit?: number;
    offset?: number;
  },
  token: string | null,
): Promise<SearchPage<SearchDestination>> {
  const response = await api.search.jump.get({ query, ...authHeaders(token) });
  if (response.error || !response.data || "error" in response.data)
    throw new Error(
      edenErrorMessage(
        response.error ?? response.data,
        "Could not search destinations",
      ),
    );
  return response.data;
}

export async function searchMessages(
  query: { q: string; limit?: number; offset?: number },
  token: string | null,
): Promise<SearchPage<SearchMessageResult>> {
  const response = await api.search.messages.get({
    query,
    ...authHeaders(token),
  });
  if (response.error || !response.data || "error" in response.data)
    throw new Error(
      edenErrorMessage(
        response.error ?? response.data,
        "Could not search messages",
      ),
    );
  return response.data;
}

export async function getMessageContext(
  messageId: string,
  token: string | null,
) {
  const response = await api.search
    .messages({ messageId })
    .context.get(authHeaders(token));
  if (response.error || !response.data || "error" in response.data)
    throw new Error(
      edenErrorMessage(
        response.error ?? response.data,
        "This message is unavailable or you no longer have access.",
      ),
    );
  return response.data;
}
