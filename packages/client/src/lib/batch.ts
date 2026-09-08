export interface BatchChildResult {
  index: number;
  tool: string;
  success: boolean;
  result?: unknown;
  error?: string;
}
