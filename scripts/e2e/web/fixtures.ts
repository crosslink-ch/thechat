import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

import { apiURL } from './environment.mjs';
export { apiURL, webURL, webHeaders } from './environment.mjs';
export async function clearCredentialFields(page: Page) {
  await page.locator('input[type=password]').evaluateAll(inputs => {
    for (const input of inputs as HTMLInputElement[]) {
      input.value = '';
      input.removeAttribute('value');
    }
  }).catch(() => {});
}
export function identity(name = 'Web acceptance') {
  return { name, email: `web-${randomUUID()}@example.invalid`, password: `Web-${randomUUID()}-9!` };
}
export async function call(request: APIRequestContext, method: string, path: string, data?: unknown, token?: string) {
  const response = await request.fetch(`${apiURL}${path}`, {
    method, ...(data === undefined ? {} : { data }),
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  expect(response.ok(), `${method} ${path}: HTTP ${response.status()}`).toBe(true);
  return response.json();
}
export async function seedWorkspace(request: APIRequestContext) {
  const alice = identity('Alice Web Test');
  const bob = identity('Bob Web Test');
  const a = await call(request, 'POST', '/auth/register', alice);
  const b = await call(request, 'POST', '/auth/register', bob);
  const workspace = await call(request, 'POST', '/workspaces/create', { name: `Web acceptance ${randomUUID().slice(0, 8)}` }, a.accessToken);
  const invite = await call(request, 'POST', '/invites/create', { workspaceId: workspace.id, email: bob.email }, a.accessToken);
  await call(request, 'POST', '/invites/accept', { inviteId: invite.id }, b.accessToken);
  const detail = await call(request, 'GET', `/workspaces/${workspace.id}`, undefined, a.accessToken);
  const dm = await call(request, 'POST', '/conversations/dm', { workspaceId: workspace.id, otherUserId: b.user.id }, a.accessToken);
  return { alice, bob, a, b, workspace, channel: detail.channels[0], dm };
}
export async function login(page: Page, person: ReturnType<typeof identity>) {
  await page.goto('/');
  await expect(page.locator('#auth-email')).toBeVisible();
  if (await page.locator('#auth-name').isVisible()) {
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
  }
  await page.locator('#auth-email').fill(person.email);
  await page.locator('#auth-password').fill(person.password);
  await page.locator('form button[type=submit]').click();
  await expect(page.locator('#auth-email')).toHaveCount(0);
}
export async function openNavigation(page: Page) {
  const toggle = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await toggle.isVisible()) await toggle.click();
}
export async function assertContained(page: Page, selector: string) {
  // VisualViewport resize events settle asynchronously in mobile WebKit.
  await expect(async () => {
  const geometry = await page.locator(selector).evaluate(element => {
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height, vw: innerWidth, vh: innerHeight };
  });
  expect(geometry.width).toBeGreaterThan(0);
  expect(geometry.height).toBeGreaterThan(0);
  expect(geometry.x).toBeGreaterThanOrEqual(-1);
  expect(geometry.y).toBeGreaterThanOrEqual(-1);
  expect(geometry.right).toBeLessThanOrEqual(geometry.vw + 1);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.vh + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }).toPass({ timeout: 5_000, intervals: [16, 50, 100] });
}
