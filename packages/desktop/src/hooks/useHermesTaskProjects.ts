import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";

export const HERMES_TASK_PROJECT_COLORS = [
  "blue",
  "violet",
  "emerald",
  "amber",
  "rose",
  "cyan",
] as const;

export type HermesTaskProjectColor =
  (typeof HERMES_TASK_PROJECT_COLORS)[number];

export interface HermesTaskProject {
  id: string;
  name: string;
  color: HermesTaskProjectColor;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface HermesTaskProjectAssignment {
  threadId: string;
  projectId: string;
}

export interface HermesTaskProjectScope {
  userId: string | null;
  conversationId: string | null;
}

function scopeKey(scope: HermesTaskProjectScope): string | null {
  if (!scope.userId || !scope.conversationId) return null;
  return JSON.stringify([scope.userId, scope.conversationId]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assignmentsByThread(
  assignments: HermesTaskProjectAssignment[],
): Record<string, string> {
  return Object.fromEntries(
    assignments.map((assignment) => [
      assignment.threadId,
      assignment.projectId,
    ]),
  );
}

export function useHermesTaskProjects(scope: HermesTaskProjectScope) {
  const { userId, conversationId } = scope;
  const currentScopeKey = scopeKey(scope);
  const scopeRef = useRef(currentScopeKey);
  const loadedScopeRef = useRef<string | null>(null);
  scopeRef.current = currentScopeKey;

  const [projects, setProjects] = useState<HermesTaskProject[]>([]);
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(Boolean(currentScopeKey));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const requestedScopeKey = scopeKey({ userId, conversationId });
    if (!requestedScopeKey || !userId || !conversationId) {
      loadedScopeRef.current = null;
      setProjects([]);
      setAssignments({});
      setLoading(false);
      setSaving(false);
      setError(null);
      return;
    }

    if (loadedScopeRef.current !== requestedScopeKey) {
      setProjects([]);
      setAssignments({});
    }
    setLoading(true);
    setSaving(false);
    setError(null);
    try {
      const localScope = { userId, conversationId };
      const [nextProjects, nextAssignments] = await Promise.all([
        invoke<HermesTaskProject[]>("list_hermes_task_projects", localScope),
        invoke<HermesTaskProjectAssignment[]>(
          "list_hermes_task_project_assignments",
          localScope,
        ),
      ]);
      if (scopeRef.current !== requestedScopeKey) return;
      loadedScopeRef.current = requestedScopeKey;
      setProjects(nextProjects);
      setAssignments(assignmentsByThread(nextAssignments));
    } catch (nextError) {
      if (scopeRef.current !== requestedScopeKey) return;
      setProjects([]);
      setAssignments({});
      setError(errorMessage(nextError));
    } finally {
      if (scopeRef.current === requestedScopeKey) setLoading(false);
    }
  }, [conversationId, userId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const createProject = useCallback(
    async (name: string, color: HermesTaskProjectColor) => {
      const requestedScopeKey = scopeKey({ userId, conversationId });
      if (!requestedScopeKey || !userId || !conversationId) {
        throw new Error("A signed-in Hermes conversation is required");
      }
      setSaving(true);
      setError(null);
      try {
        const project = await invoke<HermesTaskProject>(
          "create_hermes_task_project",
          { userId, conversationId, name, color },
        );
        if (scopeRef.current === requestedScopeKey) {
          setProjects((current) =>
            [...current, project].sort(
              (left, right) => left.position - right.position,
            ),
          );
        }
        return project;
      } catch (nextError) {
        if (scopeRef.current === requestedScopeKey) {
          setError(errorMessage(nextError));
        }
        throw nextError;
      } finally {
        if (scopeRef.current === requestedScopeKey) setSaving(false);
      }
    },
    [conversationId, userId],
  );

  const updateProject = useCallback(
    async (projectId: string, name: string, color: HermesTaskProjectColor) => {
      const requestedScopeKey = scopeKey({ userId, conversationId });
      if (!requestedScopeKey || !userId || !conversationId) {
        throw new Error("A signed-in Hermes conversation is required");
      }
      setSaving(true);
      setError(null);
      try {
        const project = await invoke<HermesTaskProject>(
          "update_hermes_task_project",
          { userId, conversationId, projectId, name, color },
        );
        if (scopeRef.current === requestedScopeKey) {
          setProjects((current) =>
            current.map((item) => (item.id === projectId ? project : item)),
          );
        }
        return project;
      } catch (nextError) {
        if (scopeRef.current === requestedScopeKey) {
          setError(errorMessage(nextError));
        }
        throw nextError;
      } finally {
        if (scopeRef.current === requestedScopeKey) setSaving(false);
      }
    },
    [conversationId, userId],
  );

  const deleteProject = useCallback(
    async (projectId: string) => {
      const requestedScopeKey = scopeKey({ userId, conversationId });
      if (!requestedScopeKey || !userId || !conversationId) {
        throw new Error("A signed-in Hermes conversation is required");
      }
      setSaving(true);
      setError(null);
      try {
        await invoke("delete_hermes_task_project", {
          userId,
          conversationId,
          projectId,
        });
        if (scopeRef.current === requestedScopeKey) {
          setProjects((current) =>
            current.filter((project) => project.id !== projectId),
          );
          setAssignments((current) =>
            Object.fromEntries(
              Object.entries(current).filter(
                ([, assignedProjectId]) => assignedProjectId !== projectId,
              ),
            ),
          );
        }
      } catch (nextError) {
        if (scopeRef.current === requestedScopeKey) {
          setError(errorMessage(nextError));
        }
        throw nextError;
      } finally {
        if (scopeRef.current === requestedScopeKey) setSaving(false);
      }
    },
    [conversationId, userId],
  );

  const assignTask = useCallback(
    async (threadId: string, projectId: string | null) => {
      const requestedScopeKey = scopeKey({ userId, conversationId });
      if (!requestedScopeKey || !userId || !conversationId) {
        throw new Error("A signed-in Hermes conversation is required");
      }
      setSaving(true);
      setError(null);
      try {
        await invoke("assign_hermes_task_to_project", {
          userId,
          conversationId,
          threadId,
          projectId,
        });
        if (scopeRef.current === requestedScopeKey) {
          setAssignments((current) => {
            const next = { ...current };
            if (projectId) next[threadId] = projectId;
            else delete next[threadId];
            return next;
          });
        }
      } catch (nextError) {
        if (scopeRef.current === requestedScopeKey) {
          setError(errorMessage(nextError));
        }
        throw nextError;
      } finally {
        if (scopeRef.current === requestedScopeKey) setSaving(false);
      }
    },
    [conversationId, userId],
  );

  return {
    projects,
    assignments,
    loading,
    saving,
    error,
    reload,
    createProject,
    updateProject,
    deleteProject,
    assignTask,
    clearError: () => setError(null),
  };
}
