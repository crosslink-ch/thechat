export type Provider = "openrouter" | "codex" | "glm";

/**
 * Error thrown by provider streaming wrappers.
 * Carries the provider name and HTTP status code so callers can
 * branch on structured fields instead of string-matching error messages.
 */
export class ProviderError extends Error {
  readonly provider: Provider;
  readonly statusCode: number | undefined;

  constructor(message: string, provider: Provider, statusCode?: number) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.statusCode = statusCode;
  }

  get isAuth(): boolean {
    return this.statusCode === 401 || this.statusCode === 403;
  }
}
