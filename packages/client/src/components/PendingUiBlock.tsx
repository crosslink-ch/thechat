export function PendingUiBlock({ code }: { code: string }) {
  return (
    <div className="my-2 rounded-lg border border-border bg-raised px-3 py-2.5">
      <div className="mb-1.5 animate-pulse text-xs text-text-dimmed">UI component loading...</div>
      <pre className="m-0 max-h-[200px] overflow-y-auto whitespace-pre-wrap font-mono text-xs text-text-secondary">{code}</pre>
    </div>
  );
}
