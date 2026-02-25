import { create } from "zustand";
import type { QuestionInfo, QuestionRequest } from "./types";

interface QuestionStoreState {
  /** Queue of pending question requests per conversation */
  pending: Record<string, QuestionRequest[]>;
}

export const useQuestionStore = create<QuestionStoreState>()(() => ({
  pending: {},
}));

let nextId = 0;

export function askQuestion(questions: QuestionInfo[], convId?: string): Promise<string[][]> {
  const key = convId ?? "_default";
  const id = String(++nextId);

  return new Promise<string[][]>((resolve, reject) => {
    const request: QuestionRequest = {
      id: String(id),
      questions,
      resolve: (answers: string[][]) => {
        removeRequest(key, id);
        resolve(answers);
      },
      reject: (reason: string) => {
        removeRequest(key, id);
        reject(new Error(reason));
      },
    };

    useQuestionStore.setState((s) => ({
      pending: {
        ...s.pending,
        [key]: [...(s.pending[key] ?? []), request],
      },
    }));
  });
}

function removeRequest(key: string, id: string) {
  useQuestionStore.setState((s) => {
    const queue = (s.pending[key] ?? []).filter((r) => r.id !== id);
    if (queue.length === 0) {
      const { [key]: _, ...rest } = s.pending;
      return { pending: rest };
    }
    return { pending: { ...s.pending, [key]: queue } };
  });
}
