import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { clearCredentialFields } from './fixtures';
test.afterEach(async ({ page }) => clearCredentialFields(page));

const apiURL = process.env.THECHAT_WEB_E2E_API_URL || 'http://127.0.0.1:13300';
const webURL = process.env.THECHAT_WEB_E2E_URL || 'http://127.0.0.1:1420';
const webHeaders = { origin: new URL(webURL).origin, 'x-thechat-client': 'web' };

function identity() {
  return { name: 'Web acceptance', email: `web-${randomUUID()}@example.invalid`, password: `Web-${randomUUID()}-9!` };
}

test('browser session has an HttpOnly cookie and no bearer token in the response', async ({ request }) => {
  const response = await request.post(`${apiURL}/auth/register`, { data: identity(), headers: webHeaders });
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.user.id).toBeTruthy();
  expect('accessToken' in body, 'browser auth must not return a reusable token').toBe(false);
  const setCookie = response.headers()['set-cookie'] || '';
  expect(/httponly/i.test(setCookie), 'HttpOnly attribute').toBe(true);
  expect(/samesite=lax/i.test(setCookie), 'SameSite=Lax attribute').toBe(true);
  if (new URL(webURL).protocol === 'https:') expect(/secure/i.test(setCookie), 'Secure attribute').toBe(true);
  const me = await request.get(`${apiURL}/auth/me`, { headers: webHeaders });
  expect(me.status()).toBe(200);
  expect((await me.json()).user.id).toBe(body.user.id);
});

test('ordinary browser can log in and restore its session without Tauri', async ({ page, request }) => {
  const person = identity();
  expect((await request.post(`${apiURL}/auth/register`, { data: person })).status()).toBe(200);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#auth-email')).toBeVisible();
  if (await page.locator('#auth-name').isVisible()) {
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
  }
  await page.locator('#auth-email').fill(person.email);
  await page.locator('#auth-password').fill(person.password);
  await page.locator('form button[type=submit]').click();
  await expect(page.locator('#auth-email')).toHaveCount(0);
  await expect(page.getByText('Create a workspace to start using channels and direct messages.')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Create a workspace to start using channels and direct messages.')).toBeVisible();
  await expect(page.locator('#auth-email')).toHaveCount(0);
  await expect(page.getByText('Loading...', { exact: true })).toHaveCount(0);
  const tracedStatus = await page.evaluate(async (url) => {
    const response = await fetch(`${url}/auth/me`, { credentials: 'include', headers: {
      'X-TheChat-Client': 'web',
      traceparent: `00-${crypto.randomUUID().replaceAll('-', '')}-1234567890abcdef-01`,
      tracestate: 'thechat=browser',
    } });
    return response.status;
  }, apiURL);
  expect(tracedStatus).toBe(200);
  const authCookies = (await page.context().cookies()).filter(cookie => cookie.httpOnly);
  expect(authCookies.length).toBeGreaterThan(0);
  const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie }));
  expect(/auth_access_token|accessToken|Bearer /.test(JSON.stringify(storage)), 'no JS-readable auth storage').toBe(false);
  for (const cookie of authCookies) expect(JSON.stringify(storage).includes(cookie.value), 'cookie secret hidden from JavaScript').toBe(false);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
