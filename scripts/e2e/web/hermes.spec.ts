import { test, expect } from '@playwright/test';
import { apiURL, webURL, seedWorkspace, login, call, clearCredentialFields } from './fixtures';
test.afterEach(async ({ page }) => clearCredentialFields(page));

test('scripted Hermes requests inline and in the Inbox, rendered reply and task thread', async ({ page, request }, info) => {
  const f = await seedWorkspace(request);
  const bot = await call(request, 'POST', '/bots/create', { name: 'Scripted Hermes', kind: 'hermes', workspaceId: f.workspace.id }, f.a.accessToken);
  const dm = await call(request, 'POST', '/conversations/dm', { workspaceId: f.workspace.id, otherUserId: bot.userId }, f.a.accessToken);
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

  const create = async (body: object) =>
    (await call(request, 'POST', '/bot-requests', { invocationId: event.invocationId, ...body }, bot.apiKey)).request;
  const botView = async (id: string) => (await call(request, 'GET', `/bot-requests/${id}`, undefined, bot.apiKey)).request;

  // Approval, answered inline. "Always allow" is offered exactly as the bot offers it.
  const approvalRequest = await create({
    clientKey: 'web:approve', kind: 'approval', title: 'Command approval required',
    body: 'Scripted approval only; no command will execute', details: { command: 'printf browser-test' },
    response: { type: 'choice', choices: ['once', 'session', 'always', 'deny'] },
  });
  const approval = page.locator(`[data-testid="bot-request-card"][data-request-id="${approvalRequest.id}"]`);
  await expect(approval).toBeVisible();
  await expect(approval).toContainText('printf browser-test');
  await expect(approval.getByRole('button', { name: 'Always allow', exact: true })).toBeVisible();
  await approval.getByRole('button', { name: 'Allow once', exact: true }).click();
  await expect.poll(async () => (await botView(approvalRequest.id)).status).toBe('answered');
  const answered = await botView(approvalRequest.id);
  expect(answered.answer).toEqual({ choice: 'once' });
  expect(answered.answeredBy?.name).toBe(f.alice.name);
  const resolvedApproval = page.locator(`[data-testid="bot-request-resolved"][data-request-id="${approvalRequest.id}"]`);
  await expect(resolvedApproval).toContainText(`Allowed once by ${f.alice.name}`);
  await expect(resolvedApproval).toContainText('waiting for Scripted Hermes to pick it up');
  await call(request, 'POST', `/bot-requests/${approvalRequest.id}/ack`, { applied: true }, bot.apiKey);
  await expect(resolvedApproval).toHaveAttribute('data-status', 'delivered');
  await expect(resolvedApproval).not.toContainText('waiting for');

  // Question, answered from the Inbox.
  const questionRequest = await create({
    clientKey: 'web:question', kind: 'question', title: 'Which browser workflow should be checked?',
    response: { type: 'choice', choices: ['Mobile first', 'Desktop first'], allowText: true },
  });
  await page.goto(`${webURL}/#/inbox`);
  const question = page.locator(`[data-testid="bot-request-card"][data-request-id="${questionRequest.id}"]`);
  await expect(question).toBeVisible();
  await expect(question).toContainText('Which browser workflow should be checked?');
  await page.screenshot({ path: info.outputPath('inbox-open-request.png'), fullPage: true });
  await question.getByRole('button', { name: 'Mobile first', exact: true }).click();
  await expect.poll(async () => (await botView(questionRequest.id)).answer).toEqual({ choice: 'Mobile first' });
  await call(request, 'POST', `/bot-requests/${questionRequest.id}/ack`, { applied: true }, bot.apiKey);
  await expect(page.getByTestId('inbox-empty')).toBeVisible();

  await page.goto(`${webURL}/#/dm/${dm.id}`);
  await expect(page.locator(`[data-testid="bot-request-resolved"][data-request-id="${questionRequest.id}"]`))
    .toContainText('Answered “Mobile first”');
  await call(request, 'POST', '/hermes-platform/messages', { invocationId: event.invocationId, content: '**Browser verified**\n\n```ts\nconst ok = true;\n```\n\n$$x^2$$', complete: true }, bot.apiKey);
  await expect(page.getByText('Browser verified', { exact: true })).toBeVisible();
  await expect(page.locator('pre').filter({ hasText: 'const ok = true;' })).toBeVisible();
  await expect(page.locator('.katex').first()).toBeVisible();
  // Answered requests stay in the conversation after the run ends.
  await expect(resolvedApproval).toBeVisible();
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
});

test('anyone in a shared channel can answer, and a second answer is told who won', async ({ page, request }) => {
  const f = await seedWorkspace(request);
  const bot = await call(request, 'POST', '/bots/create', { name: 'Channel Hermes', kind: 'hermes', workspaceId: f.workspace.id }, f.a.accessToken);
  const { request: created } = await call(request, 'POST', '/bot-requests', {
    clientKey: 'web:channel', conversationId: f.channel.id, kind: 'approval', title: 'Deploy to staging?',
    response: { type: 'choice', choices: ['once', 'deny'] },
  }, bot.apiKey);

  // Bob did not start anything, yet he may answer in the shared channel.
  await login(page, f.bob);
  await page.goto(`${webURL}/#/inbox`);
  const card = page.locator(`[data-testid="bot-request-card"][data-request-id="${created.id}"]`);
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Allow once', exact: true }).click();
  await expect(page.getByTestId('inbox-empty')).toBeVisible();

  const late = await request.fetch(`${apiURL}/bot-requests/${created.id}/answer`, {
    method: 'POST', data: { choice: 'deny' }, headers: { authorization: `Bearer ${f.a.accessToken}` },
  });
  expect(late.status()).toBe(409);
  expect((await late.json()).request.answeredBy.name).toBe(f.bob.name);
});
