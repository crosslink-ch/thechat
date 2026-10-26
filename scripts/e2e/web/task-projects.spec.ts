import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { webURL, seedWorkspace, login, call, clearCredentialFields } from './fixtures';

test.afterEach(async ({ page }) => clearCredentialFields(page));

async function hermesDmWithTasks(request: APIRequestContext, titles: string[]) {
  const f = await seedWorkspace(request);
  const bot = await call(request, 'POST', '/bots/create', {
    name: 'Projects acceptance Hermes', kind: 'hermes', workspaceId: f.workspace.id,
  }, f.a.accessToken);
  const dm = await call(request, 'POST', '/conversations/dm', {
    workspaceId: f.workspace.id, otherUserId: bot.userId,
  }, f.a.accessToken);
  const tasks: Array<{ id: string; title: string }> = [];
  for (const title of titles) {
    tasks.push(await call(request, 'POST', `/conversations/threads/${dm.id}`, {
      botId: bot.id, title,
    }, f.a.accessToken));
  }
  return { f, dm, tasks };
}

async function serverState(request: APIRequestContext, dmId: string, token: string) {
  const threads = await call(request, 'GET', `/conversations/threads/${dmId}`, undefined, token);
  const projects = await call(request, 'GET', `/conversations/projects/${dmId}`, undefined, token);
  return {
    projects: projects as Array<{ id: string; name: string }>,
    projectOf: Object.fromEntries(
      (threads.items as Array<{ title: string; projectId: string | null }>).map((t) => [t.title, t.projectId]),
    ),
  };
}

/** Screenshots wait for dialog/menu entry animations (they start transparent and blurred). */
async function settled(page: Page) {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))));
}

async function runPaletteCommand(page: Page, label: string) {
  await page.keyboard.press('Control+Shift+P');
  const palette = page.getByTestId('palette-panel');
  await palette.getByPlaceholder('Type a command...').fill(label);
  // Click the exact entry: Enter runs whichever row is highlighted, which can
  // still be a previous match while the filter re-renders.
  await palette.getByRole('button', { name: label, exact: true }).click();
  await expect(palette).toHaveCount(0);
}

test('New Project, drag a task in, delete a task, and everything persists', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'chromium-desktop', 'Drag and drop is a desktop pointer interaction');
  const { f, dm, tasks } = await hermesDmWithTasks(request, ['Budget draft', 'Hiring plan', 'Scratch notes']);
  const [budget, , scratch] = tasks;

  await login(page, f.alice);
  await page.goto(`${webURL}/#/dm/${dm.id}?threadId=${scratch.id}`);
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();

  // Command palette: New Project.
  await runPaletteCommand(page, 'New Project');
  const nameInput = page.getByRole('textbox', { name: 'Project name' });
  await expect(nameInput).toBeFocused();
  await nameInput.fill('Q4 planning');
  await settled(page);
  await page.screenshot({ path: info.outputPath('new-project-dialog.png') });
  await page.getByRole('button', { name: 'Create project' }).click();
  const project = page.getByRole('group', { name: 'Project Q4 planning' });
  await expect(project).toBeVisible();
  await expect(project.getByText('Drag tasks here')).toBeVisible();

  // Real mouse drag of a task row onto the project.
  const row = page.locator(`[data-task-row="${budget.id}"]`);
  const from = (await row.boundingBox())!;
  const to = (await project.boundingBox())!;
  await page.mouse.move(from.x + 40, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 60, from.y + from.height / 2 + 10, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + 12, { steps: 12 });
  await expect(project).toHaveClass(/border-accent/);
  await page.screenshot({ path: info.outputPath('dragging-task.png') });
  await page.mouse.up();
  await expect(project.getByText('Budget draft', { exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Tasks without a project' }).getByText('Hiring plan')).toBeVisible();

  await expect.poll(async () => (await serverState(request, dm.id, f.a.accessToken)).projectOf['Budget draft'])
    .toBe((await serverState(request, dm.id, f.a.accessToken)).projects[0].id);
  // Dragging must not have opened the task.
  await expect(page.locator('header').getByText('Scratch notes', { exact: true })).toBeVisible();
  // "No project" lines its count up with the project headers' counts.
  const countRight = async (name: string) => {
    const box = await page.getByRole('group', { name }).locator('span.tabular-nums').first().boundingBox();
    return box!.x + box!.width;
  };
  expect(Math.abs((await countRight('Project Q4 planning')) - (await countRight('Tasks without a project')))).toBeLessThan(1);
  await page.screenshot({ path: info.outputPath('organized-tasks.png') });

  // Command palette: Delete Task (the active task) with confirmation.
  await runPaletteCommand(page, 'Delete Task');
  const confirm = page.getByRole('dialog', { name: 'Delete task “Scratch notes”?' });
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await settled(page);
  await page.screenshot({ path: info.outputPath('delete-task-confirm.png') });
  await confirm.getByRole('button', { name: 'Delete task' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(page.locator(`[data-task-row="${scratch.id}"]`)).toHaveCount(0);
  await expect(page.locator('header').getByText('General', { exact: true })).toBeVisible();

  const state = await serverState(request, dm.id, f.a.accessToken);
  expect(state.projects.map((p) => p.name)).toEqual(['Q4 planning']);
  expect(state.projectOf).toEqual({ 'Budget draft': state.projects[0].id, 'Hiring plan': null });

  // Server-backed: the grouping survives a full reload.
  await page.reload();
  await expect(page.getByRole('group', { name: 'Project Q4 planning' }).getByText('Budget draft', { exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Tasks without a project' }).getByText('Hiring plan', { exact: true })).toBeVisible();
  await expect(page.getByText('Scratch notes', { exact: true })).toHaveCount(0);
});

test('A quiet project keeps its tasks when more than a page of newer tasks exists', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'chromium-desktop', 'Paging is layout independent');
  const { f, dm } = await hermesDmWithTasks(request, []);
  const project = await call(request, 'POST', `/conversations/projects/${dm.id}`, { name: 'Security' }, f.a.accessToken);
  for (const title of ['Rotate keys', 'Audit logins']) {
    await call(request, 'POST', `/conversations/threads/${dm.id}`, { title, projectId: project.id }, f.a.accessToken);
  }
  // 52 newer unfiled tasks: more than one 50-task page, all newer than Security's.
  const unfiled: Array<{ id: string; title: string }> = [];
  for (let index = 1; index <= 52; index += 1) {
    unfiled.push(await call(request, 'POST', `/conversations/threads/${dm.id}`, { title: `Chore ${index}` }, f.a.accessToken));
  }

  await login(page, f.alice);
  await page.goto(`${webURL}/#/dm/${dm.id}`);
  const security = page.getByRole('group', { name: 'Project Security' });
  await expect(security.getByText('Rotate keys', { exact: true })).toBeVisible();
  await expect(security.getByText('Audit logins', { exact: true })).toBeVisible();
  await expect(security.locator('span.tabular-nums')).toHaveText('2');

  const noProject = page.getByRole('group', { name: 'Tasks without a project' });
  await expect(noProject.locator('span.tabular-nums')).toHaveText('52');
  await expect(noProject.locator('[data-task-row]')).toHaveCount(50);
  await expect(noProject.getByText('Chore 1', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('quiet-project-visible.png') });
  await noProject.getByRole('button', { name: 'Load more tasks without a project' }).click();
  await expect(noProject.locator('[data-task-row]')).toHaveCount(52);
  await expect(noProject.getByRole('button', { name: /Load more/ })).toHaveCount(0);

  // A link to a task beyond the first page opens that task, not General.
  await page.goto(`${webURL}/#/`);
  await page.goto(`${webURL}/#/dm/${dm.id}?threadId=${unfiled[0].id}`);
  await expect(page.locator('header').getByText('Chore 1', { exact: true })).toBeVisible();
  await expect(noProject.locator(`[data-task-row="${unfiled[0].id}"]`)).toBeVisible();
});

test('Phone users move tasks through the row menu', async ({ page, request }, info) => {
  test.skip(info.project.name === 'chromium-desktop', 'Covers the touch layout');
  const { f, dm, tasks } = await hermesDmWithTasks(request, ['Phone task']);
  await call(request, 'POST', `/conversations/projects/${dm.id}`, { name: 'Errands' }, f.a.accessToken);

  await login(page, f.alice);
  await page.goto(`${webURL}/#/dm/${dm.id}`);
  await page.getByRole('button', { name: /Open tasks and activity/ }).click();
  const drawer = page.getByRole('dialog', { name: 'Tasks and activity' });
  await drawer.getByRole('button', { name: 'Task actions for Phone task' }).click();
  await page.getByRole('menuitem', { name: 'Move to project...' }).click();
  const move = page.getByRole('dialog', { name: 'Move “Phone task”' });
  await move.getByRole('button', { name: 'Errands' }).click();
  await expect(move).toHaveCount(0);
  await expect(drawer.getByRole('group', { name: 'Project Errands' }).getByText('Phone task')).toBeVisible();
  await page.screenshot({ path: info.outputPath('phone-moved-task.png') });

  const state = await serverState(request, dm.id, f.a.accessToken);
  expect(state.projectOf['Phone task']).toBe(state.projects[0].id);
  expect(tasks).toHaveLength(1);
});
