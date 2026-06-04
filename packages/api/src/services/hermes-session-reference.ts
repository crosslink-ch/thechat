import type { HermesSessionReference } from "@thechat/shared";

type HermesSessionReferenceInput = Record<string, unknown>;

const MAX_SESSION_FIELD_LENGTH = 2048;

export function normalizeHermesSessionReference(
  value: unknown,
  options: { reason?: string | null; source?: string | null; now?: Date } = {},
): HermesSessionReference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as HermesSessionReferenceInput;
  const sessionId = stringField(record.sessionId ?? record.session_id);
  const sessionKey = stringField(record.sessionKey ?? record.session_key);
  const lineageRootId =
    stringField(record.lineageRootId ?? record.lineage_root_id) ??
    sessionId ??
    stringField(record.branchFromLineageRootId ?? record.branch_from_lineage_root_id);
  const branchFromSessionId = stringField(record.branchFromSessionId ?? record.branch_from_session_id);
  const branchFromThreadId = stringField(record.branchFromThreadId ?? record.branch_from_thread_id);
  const branchFromLineageRootId = stringField(record.branchFromLineageRootId ?? record.branch_from_lineage_root_id);
  const branchTitle = stringField(record.branchTitle ?? record.branch_title);

  if (!sessionId && !sessionKey && !branchFromSessionId) return null;

  return {
    sessionId,
    sessionKey,
    lineageRootId,
    reason: stringField(record.reason) ?? options.reason ?? null,
    source: stringField(record.source) ?? options.source ?? "hermes",
    ...(branchFromSessionId ? { branchFromSessionId } : {}),
    ...(branchFromThreadId ? { branchFromThreadId } : {}),
    ...(branchFromLineageRootId ? { branchFromLineageRootId } : {}),
    ...(branchTitle ? { branchTitle } : {}),
    updatedAt: stringField(record.updatedAt ?? record.updated_at) ?? (options.now ?? new Date()).toISOString(),
  };
}

export function hermesSessionReferenceFromJson(value: unknown): HermesSessionReference | null {
  return normalizeHermesSessionReference(value);
}

export function mergeHermesSessionIntoJson(
  previous: unknown,
  session: HermesSessionReference | null,
) {
  const record = previous && typeof previous === "object" && !Array.isArray(previous)
    ? { ...(previous as Record<string, unknown>) }
    : {};
  if (!session) return record;
  return {
    ...record,
    hermesSession: session,
  };
}

function stringField(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_SESSION_FIELD_LENGTH);
}
