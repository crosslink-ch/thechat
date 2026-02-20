import type { QuestionInfo, QuestionRequest } from "./types";

type QuestionListener = (request: QuestionRequest) => void;

let listener: QuestionListener | null = null;
let nextId = 0;

export function onQuestionRequest(callback: QuestionListener): () => void {
  listener = callback;
  return () => {
    if (listener === callback) {
      listener = null;
    }
  };
}

export function askQuestion(questions: QuestionInfo[]): Promise<string[][]> {
  return new Promise<string[][]>((resolve, reject) => {
    if (!listener) {
      reject(new Error("No question handler registered"));
      return;
    }

    const request: QuestionRequest = {
      id: String(++nextId),
      questions,
      resolve,
      reject: (reason: string) => reject(new Error(reason)),
    };

    listener(request);
  });
}
