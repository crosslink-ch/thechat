export interface WebE2EEnvironment {
  webURL: string;
  apiURL: string;
  webHeaders: { origin: string; 'x-thechat-client': 'web' };
}
export function resolveWebE2EEnvironment(env?: Record<string, string | undefined>): WebE2EEnvironment;
export const webURL: string;
export const apiURL: string;
export const webHeaders: WebE2EEnvironment['webHeaders'];
