import { defineConfig, devices } from '@playwright/test';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const baseURL = process.env.THECHAT_WEB_E2E_URL || 'http://127.0.0.1:1420';
const apiURL = process.env.THECHAT_WEB_E2E_API_URL || 'http://127.0.0.1:13300';
for (const value of [baseURL, apiURL]) {
  const url = new URL(value);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Web E2E creates synthetic accounts and must target loopback only');
  }
}
const artifacts = resolve(process.env.THECHAT_WEB_E2E_ARTIFACTS || `${homedir()}/.cache/thechat/web-e2e`);
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: `${artifacts}/results`,
  reporter: [['list'], ['json', { outputFile: `${artifacts}/results.json` }]],
  use: { baseURL, ignoreHTTPSErrors: true, screenshot: 'only-on-failure', trace: 'off' },
  projects: [
    { name: 'chromium-desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    { name: 'chromium-phone', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
    { name: 'webkit-phone', use: { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } } },
  ],
});
