import { create } from "zustand";
import type { QuestionInfo, QuestionRequest } from "./types";

interface QuestionStoreState {
  /** Pending question requests keyed by conversation ID */
  pending: Record<string, QuestionRequest>;
}

export const useQuestionStore = create<QuestionStoreState>()(() => ({
  pending: {},
}));

let nextId = 0;

export function askQuestion(questions: QuestionInfo[], convId?: string): Promise<string[][]> {
  const key = convId ?? "_default";

  return new Promise<string[][]>((resolve, reject) => {
    const request: QuestionRequest = {
      id: String(++nextId),
      questions,
      resolve: (answers: string[][]) => {
        useQuestionStore.setState((s) => {
          const { [key]: _, ...rest } = s.pending;
          return { pending: rest };
        });
        resolve(answers);
      },
      reject: (reason: string) => {
        useQuestionStore.setState((s) => {
          const { [key]: _, ...rest } = s.pending;
          return { pending: rest };
        });
        reject(new Error(reason));
      },
    };

    useQuestionStore.setState((s) => ({
      pending: { ...s.pending, [key]: request },
    }));
  });
}
