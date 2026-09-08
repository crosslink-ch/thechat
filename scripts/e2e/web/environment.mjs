/** One endpoint contract for configuration, peers, navigation and cookie headers. */
export function resolveWebE2EEnvironment(env = process.env) {
  const webURL = env.THECHAT_WEB_E2E_URL || 'http://127.0.0.1:1422';
  const apiURL = env.THECHAT_WEB_E2E_API_URL || 'http://127.0.0.1:13300';
  for (const value of [webURL, apiURL]) {
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(value).hostname)) {
      throw new Error('Web E2E creates synthetic accounts and must target loopback only');
    }
  }
  return { webURL, apiURL, webHeaders: { origin: new URL(webURL).origin, 'x-thechat-client': 'web' } };
}
export const { webURL, apiURL, webHeaders } = resolveWebE2EEnvironment();
