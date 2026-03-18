import { useState, useEffect } from "react";

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining}s`;
}

export function useElapsedTime(startTime: number | null): string | null {
  const [elapsed, setElapsed] = useState<string | null>(null);

  useEffect(() => {
    if (startTime === null) {
      setElapsed(null);
      return;
    }

    // Compute immediately so we don't wait 1s for first render
    setElapsed(formatElapsed(Date.now() - startTime));

    const id = setInterval(() => {
      setElapsed(formatElapsed(Date.now() - startTime));
    }, 1000);

    return () => clearInterval(id);
  }, [startTime]);

  return elapsed;
}
