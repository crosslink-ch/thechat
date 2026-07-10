export function retryDelayMs(attempts: number) {
  const exponent = Math.max(0, Math.min(attempts - 1, 10));
  return Math.min(60_000, 1_000 * 2 ** exponent);
}
