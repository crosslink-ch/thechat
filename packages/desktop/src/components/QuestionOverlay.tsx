import { useRef, useState } from "react";
import type { QuestionRequest } from "../core/types";

const CUSTOM = "__custom__";

interface QuestionOverlayProps {
  request: QuestionRequest;
  onSubmit: (answers: string[][]) => void;
  onCancel: () => void;
}

export function QuestionOverlay({ request, onSubmit, onCancel }: QuestionOverlayProps) {
  const [selections, setSelections] = useState<string[][]>(
    request.questions.map(() => []),
  );
  const [customText, setCustomText] = useState<string[]>(
    request.questions.map(() => ""),
  );
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  const toggleOption = (qIndex: number, value: string) => {
    setSelections((prev) => {
      const updated = [...prev];
      const current = updated[qIndex] ?? [];
      const isMultiple = request.questions[qIndex]?.multiple;

      if (isMultiple) {
        updated[qIndex] = current.includes(value)
          ? current.filter((v) => v !== value)
          : [...current, value];
      } else {
        updated[qIndex] = current[0] === value ? [] : [value];
      }
      return updated;
    });
  };

  const activateCustom = (qIndex: number) => {
    const isMultiple = request.questions[qIndex]?.multiple;
    setSelections((prev) => {
      const updated = [...prev];
      const current = updated[qIndex] ?? [];
      if (isMultiple) {
        if (!current.includes(CUSTOM)) {
          updated[qIndex] = [...current, CUSTOM];
        }
      } else {
        updated[qIndex] = [CUSTOM];
      }
      return updated;
    });
  };

  const handleSubmit = () => {
    const final = selections.map((sel, i) => {
      return sel
        .map((v) => (v === CUSTOM ? customText[i]?.trim() ?? "" : v))
        .filter(Boolean);
    });
    onSubmit(final);
  };

  return (
    <div className="question-overlay">
      <div className="question-card">
        {request.questions.map((q, qIndex) => {
          const current = selections[qIndex] ?? [];
          const customActive = current.includes(CUSTOM);

          return (
            <div key={qIndex} className="question-block">
              <div className="question-header">{q.header}</div>
              <div className="question-text">{q.question}</div>
              <div className="question-options">
                {q.options.map((opt) => (
                  <button
                    key={opt.label}
                    className={`question-option ${current.includes(opt.label) ? "question-option-selected" : ""}`}
                    onClick={() => toggleOption(qIndex, opt.label)}
                  >
                    <span className="question-option-label">{opt.label}</span>
                    <span className="question-option-desc">{opt.description}</span>
                  </button>
                ))}
                <div
                  className={`question-option question-option-custom ${customActive ? "question-option-selected" : ""}`}
                  onClick={() => {
                    toggleOption(qIndex, CUSTOM);
                    if (!customActive) {
                      inputRefs.current[qIndex]?.focus();
                    }
                  }}
                >
                  <input
                    ref={(el) => { inputRefs.current[qIndex] = el; }}
                    type="text"
                    placeholder="Type your own answer..."
                    value={customText[qIndex] ?? ""}
                    onClick={(e) => e.stopPropagation()}
                    onFocus={() => activateCustom(qIndex)}
                    onChange={(e) => {
                      const value = e.target.value;
                      setCustomText((prev) => {
                        const updated = [...prev];
                        updated[qIndex] = value;
                        return updated;
                      });
                      activateCustom(qIndex);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleSubmit();
                      }
                    }}
                  />
                </div>
              </div>
            </div>
          );
        })}
        <div className="question-actions">
          <button className="question-btn question-btn-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button className="question-btn question-btn-submit" onClick={handleSubmit}>
            Submit
          </button>
        </div>
      </div>
    </div>
  );
}
