import { askQuestion } from "../question";
import type { QuestionInfo } from "../types";
import { defineTool } from "./define";

export const questionTool = defineTool({
  name: "question",
  description: `Ask the user one or more questions. Use this when you need clarification, preferences, or decisions from the user.
Each question can have predefined options for the user to choose from.
The user can always type a custom answer instead of selecting an option.
Returns the user's answers as an array of selected options per question.`,
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            question: { type: "string", description: "The question to ask" },
            header: { type: "string", description: "Short label for the question (max 12 chars)" },
            options: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: { type: "string", description: "Option display text" },
                  description: { type: "string", description: "Option description" },
                },
                required: ["label", "description"],
              },
              description: "Available choices (2-4 options)",
            },
            multiple: { type: "boolean", description: "Allow selecting multiple options" },
          },
          required: ["question", "header", "options"],
        },
        description: "Array of questions to ask (1-4 questions)",
      },
    },
    required: ["questions"],
  },
  execute: async (args) => {
    const { questions } = args as { questions: QuestionInfo[] };

    const answers = await askQuestion(questions);

    // Format answers for display
    const formatted = questions.map((q, i) => ({
      question: q.question,
      answers: answers[i] ?? [],
    }));

    return { responses: formatted };
  },
});
