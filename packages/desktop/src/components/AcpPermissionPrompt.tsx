import type { AcpPermissionRequest } from "@thechat/shared";

interface AcpPermissionPromptProps {
  request: AcpPermissionRequest;
  onChoice: (optionId: string) => void;
  busy?: boolean;
}

export function AcpPermissionPrompt({
  request,
  onChoice,
  busy = false,
}: AcpPermissionPromptProps) {
  return (
    <section
      data-testid="acp-permission-inline"
      className="flow-root my-3 rounded-lg border border-warning/30 bg-warning-bg p-3"
      aria-labelledby={`acp-permission-${request.id}`}
      role="alert"
      aria-live="assertive"
    >
      <h3
        id={`acp-permission-${request.id}`}
        className="text-[0.857rem] font-semibold text-warning-text"
      >
        {request.title}
      </h3>
      {request.description && (
        <p className="mt-1 whitespace-pre-wrap text-[0.786rem] leading-5 text-text-muted">
          {request.description}
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {request.options.map((option, index) => (
          <button
            key={option.id}
            type="button"
            disabled={busy}
            autoFocus={index === 0}
            onClick={() => onChoice(option.id)}
            className={`rounded-md border px-2.5 py-1.5 text-[0.786rem] font-medium disabled:cursor-wait disabled:opacity-50 ${
              option.kind?.startsWith("reject")
                ? "border-error/30 bg-error/10 text-error-bright"
                : "border-border bg-raised text-text-secondary hover:bg-hover"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </section>
  );
}
