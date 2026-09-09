import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { apiURL, webURL, seedWorkspace, login, call, clearCredentialFields } from './fixtures';
test.afterEach(async ({ page }) => clearCredentialFields(page));

test('scripted Hermes progress, approval, clarification, rendered reply and task thread', async ({ page, request }, info) => {
  const f = await seedWorkspace(request);
  const bot = await call(request, 'POST', '/bots/create', { name: 'Scripted Hermes', kind: 'hermes', workspaceId: f.workspace.id }, f.a.accessToken);
  const dm = await call(request, 'POST', '/conversations/dm', { workspaceId: f.workspace.id, otherUserId: bot.userId }, f.a.accessToken);
  const receipts: Array<{ payload: any; signature: string; timestamp: string; body: string }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    receipts.push({ payload: JSON.parse(body), signature: String(req.headers['x-webhook-signature'] || ''), timestamp: String(req.headers['x-webhook-timestamp'] || ''), body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    await login(page, f.alice);
    await page.goto(`${webURL}/#/dm/${dm.id}`);
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Scripted Hermes browser acceptance');
    await page.getByTitle('Send message', { exact: true }).click();
    let event: any;
    await expect.poll(async () => {
      const claimed = await call(request, 'GET', '/hermes-platform/events?limit=10', undefined, bot.apiKey);
      event ||= claimed.events.find((candidate: any) => candidate.conversation?.id === dm.id);
      return Boolean(event?.invocationId);
    }).toBe(true);
    const registered = await call(request, 'POST', '/bots/me/webhook', { url: `http://127.0.0.1:${port}/hermes-test` }, bot.apiKey);
    const progress = (type: string, payload: object) => call(request, 'POST', `/hermes-platform/invocations/${event.invocationId}/progress`, { type, status: type.endsWith('.request') ? 'waiting' : 'completed', payload }, bot.apiKey);
    await progress('approval.request', { requestId: 'web-approve', sessionKey: 'web-session', command: 'printf browser-test', description: 'Scripted approval only; no command will execute', choices: ['once', 'deny'] });
    const approval = page.getByTestId('hermes-approval-request');
    await expect(approval).toBeVisible();
    await approval.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect.poll(() => receipts.filter(r => r.payload.interaction?.requestId === 'web-approve').length).toBe(1);
    const receipt = receipts.find(r => r.payload.interaction?.requestId === 'web-approve')!;
    expect(receipt.payload.interaction.response).toBe('once');
    expect(receipt.signature === createHmac('sha256', registered.webhookSecret).update(`${receipt.timestamp}.${receipt.body}`).digest('hex'), 'signed callback').toBe(true);
    await progress('approval.resolved', { requestId: 'web-approve', sessionKey: 'web-session', choice: 'once' });

    await progress('clarify.request', { requestId: 'web-question', sessionKey: 'web-session', question: 'Which browser workflow should be checked?', choices: ['Mobile first', 'Desktop first'], multiSelect: false, allowOther: true });
    const question = page.getByTestId('hermes-clarify-request');
    await expect(question).toBeVisible();
    await question.getByRole('button', { name: /Mobile first/ }).click();
    await expect.poll(() => receipts.filter(r => r.payload.interaction?.requestId === 'web-question').length).toBe(1);
    expect(receipts.find(r => r.payload.interaction?.requestId === 'web-question')!.payload.interaction.response).toBe('Mobile first');
    await progress('clarify.resolved', { requestId: 'web-question', sessionKey: 'web-session', response: 'Mobile first' });
    await call(request, 'POST', '/hermes-platform/messages', { invocationId: event.invocationId, content: '**Browser verified**\n\n```ts\nconst ok = true;\n```\n\n$$x^2$$', complete: true }, bot.apiKey);
    await expect(page.getByText('Browser verified', { exact: true })).toBeVisible();
    await expect(page.locator('pre').filter({ hasText: 'const ok = true;' })).toBeVisible();
    await expect(page.locator('.katex').first()).toBeVisible();
    await page.screenshot({ path: info.outputPath('hermes-browser-reply.png'), fullPage: true });

    const openTasks = page.getByRole('button', { name: 'Open tasks and activity', exact: true });
    if (await openTasks.isVisible()) await openTasks.click();
    await page.getByRole('button', { name: 'New task', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('A dedicated web task');
    await page.getByTitle('Send message', { exact: true }).click();
    await expect.poll(async () => {
      const threads = await call(request, 'GET', `/conversations/threads/${dm.id}`, undefined, f.a.accessToken);
      return threads.items.length;
    }).toBe(1);
    await expect(page.getByTestId('hermes-dm-chat-scroll').getByText('A dedicated web task', { exact: true })).toBeVisible();
  } finally {
    try {
      await call(request, 'DELETE', '/bots/me/webhook', undefined, bot.apiKey);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }
});
