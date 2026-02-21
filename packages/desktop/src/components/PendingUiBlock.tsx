export function PendingUiBlock({ code }: { code: string }) {
  return (
    <div className="ui-block-pending">
      <div className="ui-block-pending-label">UI component loading...</div>
      <pre className="ui-block-pending-code">{code}</pre>
    </div>
  );
}
