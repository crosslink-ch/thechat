import { useState } from "react";
import type { QuestionRequest } from "../core/types";

interface QuestionOverlayProps {
  request: QuestionRequest;
  onSubmit: (answers: string[][]) => void;
  onCancel: () => void;
}

export function QuestionOverlay({ request, onSubmit, onCancel }: QuestionOverlayProps) {
  const [answers, setAnswers] = useState<string[][]>(
    request.questions.map(() => []),
  );
  const [customInputs, setCustomInputs] = useState<string[]>(
    request.questions.map(() => ""),
  );

  const toggleOption = (qIndex: number, label: string) => {
    setAnswers((prev) => {
      const updated = [...prev];
      const current = updated[qIndex] ?? [];
      const isMultiple = request.questions[qIndex]?.multiple;

      if (isMultiple) {
        if (current.includes(label)) {
          updated[qIndex] = current.filter((a) => a !== label);
        } else {
          updated[qIndex] = [...current, label];
        }
      } else {
        updated[qIndex] = [label];
      }
      return updated;
    });
  };

  const submitCustomAnswer = (qIndex: number) => {
    const text = customInputs[qIndex]?.trim();
    if (!text) return;
    setAnswers((prev) => {
      const updated = [...prev];
      const isMultiple = request.questions[qIndex]?.multiple;
      if (isMultiple) {
        updated[qIndex] = [...(updated[qIndex] ?? []), text];
      } else {
        updated[qIndex] = [text];
      }
      return updated;
    });
    setCustomInputs((prev) => {
      const updated = [...prev];
      updated[qIndex] = "";
      return updated;
    });
  };

  return (
    <div className="question-overlay">
      <div className="question-card">
        {request.questions.map((q, qIndex) => (
          <div key={qIndex} className="question-block">
            <div className="question-header">{q.header}</div>
            <div className="question-text">{q.question}</div>
            <div className="question-options">
              {q.options.map((opt) => {
                const selected = (answers[qIndex] ?? []).includes(opt.label);
                return (
                  <button
                    key={opt.label}
                    className={`question-option ${selected ? "question-option-selected" : ""}`}
                    onClick={() => toggleOption(qIndex, opt.label)}
                  >
                    <span className="question-option-label">{opt.label}</span>
                    <span className="question-option-desc">{opt.description}</span>
                  </button>
                );
              })}
            </div>
            <div className="question-custom">
              <input
                type="text"
                placeholder="Type your own answer..."
                value={customInputs[qIndex] ?? ""}
                onChange={(e) =>
                  setCustomInputs((prev) => {
                    const updated = [...prev];
                    updated[qIndex] = e.target.value;
                    return updated;
                  })
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitCustomAnswer(qIndex);
                  }
                }}
              />
            </div>
          </div>
        ))}
        <div className="question-actions">
          <button className="question-btn question-btn-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button className="question-btn question-btn-submit" onClick={() => onSubmit(answers)}>
            Submit
          </button>
        </div>
      </div>
    </div>
  );
}
