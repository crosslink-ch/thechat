import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { webURL, seedWorkspace, login, call, clearCredentialFields } from './fixtures';

test.afterEach(async ({ page }) => clearCredentialFields(page));

async function hermesDm(request: APIRequestContext) {
  const f = await seedWorkspace(request);
  const bot = await call(request, 'POST', '/bots/create', {
    name: 'Branches acceptance Hermes', kind: 'hermes', workspaceId: f.workspace.id,
  }, f.a.accessToken);
  const dm = await call(request, 'POST', '/conversations/dm', {
    workspaceId: f.workspace.id, otherUserId: bot.userId,
  }, f.a.accessToken);
  const createTask = (body: Record<string, unknown>) =>
    call(request, 'POST', `/conversations/threads/${dm.id}`, { botId: bot.id, ...body }, f.a.accessToken);
  return { f, bot, dm, createTask };
}

async function serverTasks(request: APIRequestContext, dmId: string, token: string) {
  const threads = await call(request, 'GET', `/conversations/threads/${dmId}`, undefined, token);
  return Object.fromEntries(
    (threads.items as Array<{ title: string; branchFromThreadId: string | null; projectId: string | null }>)
      .map((t) => [t.title, { from: t.branchFromThreadId ?? null, projectId: t.projectId ?? null }]),
  );
}

/** Screenshots wait for menu/dialog entry animations to finish. */
async function settled(page: Page) {
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))));
}

const row = (page: Page, id: string) => page.locator(`[data-task-row="${id}"]`);
const header = (page: Page) => page.locator('header');

test('Branches nest under their source, can be made from the UI, and survive moves and deletes', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'chromium-desktop', 'The task panel is a desktop sidebar');
  const { f, dm, createTask } = await hermesDm(request);
  const plan = await createTask({ title: 'Launch plan' });
  const draft = await createTask({ title: 'Draft announcement', branchFromThreadId: plan.id });
  const review = await createTask({ title: 'Legal review', branchFromThreadId: draft.id });
  const expenses = await createTask({ title: 'Expenses' });

  await login(page, f.alice);
  await page.goto(`${webURL}/#/dm/${dm.id}?threadId=${review.id}`);
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();

  // The sidebar shows the tree: plan > draft > review.
  const planBranches = page.getByRole('group', { name: 'Branches of Launch plan' });
  const draftBranches = planBranches.getByRole('group', { name: 'Branches of Draft announcement' });
  await expect(planBranches.locator(`[data-task-row="${draft.id}"]`)).toBeVisible();
  await expect(draftBranches.locator(`[data-task-row="${review.id}"]`)).toBeVisible();
  await expect(row(page, expenses.id)).toBeVisible();
  await expect(row(page, review.id)).toHaveAttribute('data-task-branch', 'true');

  // The branch bar shows the lineage and an empty branch explains itself.
  const bar = page.getByRole('navigation', { name: 'Task branches' });
  await expect(bar.getByText('Branched from')).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Launch plan' })).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Draft announcement' })).toBeVisible();
  await expect(page.getByTestId('branch-empty-state')).toContainText('Branch of “Draft announcement”');
  await page.screenshot({ path: info.outputPath('01-branch-tree-and-lineage.png') });

  // Breadcrumb navigates to the source task, which lists its branches.
  await bar.getByRole('button', { name: 'Launch plan' }).click();
  await expect(header(page).getByText('Launch plan', { exact: true })).toBeVisible();
  const sourceBar = page.getByRole('navigation', { name: 'Task branches' });
  await sourceBar.getByRole('button', { name: '1 branch from this task' }).click();
  await expect(page.getByRole('menuitem', { name: 'Draft announcement' })).toBeVisible();
  await settled(page);
  await page.screenshot({ path: info.outputPath('02-source-task-branch-menu.png') });
  await page.keyboard.press('Escape');

  // Branch the open task from the header: it opens and nests under its source.
  await page.getByTestId('branch-active-task').click();
  await expect(header(page).getByText('Launch plan branch', { exact: true })).toBeVisible();
  await expect(planBranches.getByText('Launch plan branch', { exact: true })).toBeVisible();
  await expect.poll(async () => (await serverTasks(request, dm.id, f.a.accessToken))['Launch plan branch']?.from)
    .toBe(plan.id);

  // Branch another task from its row menu, without opening it first.
  await row(page, expenses.id).hover();
  await page.getByRole('button', { name: 'Task actions for Expenses', exact: true }).click();
  await settled(page);
  await page.screenshot({ path: info.outputPath('03-row-menu-branch-from-here.png') });
  await page.getByRole('menuitem', { name: 'Branch from here' }).click();
  await expect(header(page).getByText('Expenses branch', { exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Branches of Expenses' }).getByText('Expenses branch', { exact: true })).toBeVisible();

  // C-x b branches the open task again; the name is numbered.
  await row(page, expenses.id).getByText('Expenses', { exact: true }).click();
  await expect(header(page).getByText('Expenses', { exact: true })).toBeVisible();
  await page.keyboard.press('Control+x');
  await page.keyboard.press('b');
  await expect(header(page).getByText('Expenses branch 2', { exact: true })).toBeVisible();

  // Fold the plan tree; the toggle keeps the count visible.
  await page.getByRole('button', { name: 'Hide 3 branches of Launch plan' }).click();
  await expect(page.getByRole('group', { name: 'Branches of Launch plan' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Show 3 branches of Launch plan/ })).toBeVisible();
  await page.screenshot({ path: info.outputPath('04-folded-tree.png') });
  await page.getByRole('button', { name: /^Show 3 branches of Launch plan/ }).click();

  // Move the plan into a project: its branches follow, in the browser and on the server.
  const project = await call(request, 'POST', `/conversations/projects/${dm.id}`, { name: 'Launch' }, f.a.accessToken);
  await page.reload();
  await row(page, plan.id).hover();
  await page.getByRole('button', { name: 'Task actions for Launch plan', exact: true }).click();
  await page.getByRole('menuitem', { name: /Move to project/ }).click();
  await page.getByRole('dialog', { name: 'Move “Launch plan”' }).getByRole('button', { name: 'Launch' }).click();
  const launch = page.getByRole('group', { name: 'Project Launch' });
  await expect(launch.locator(`[data-task-row="${review.id}"]`)).toBeVisible();
  await expect(launch.getByRole('group', { name: 'Branches of Launch plan' })).toBeVisible();
  const afterMove = await serverTasks(request, dm.id, f.a.accessToken);
  expect(afterMove['Launch plan'].projectId).toBe(project.id);
  expect(afterMove['Draft announcement'].projectId).toBe(project.id);
  expect(afterMove['Legal review'].projectId).toBe(project.id);
  expect(afterMove['Launch plan branch'].projectId).toBe(project.id);
  expect(afterMove['Expenses'].projectId).toBeNull();
  await page.screenshot({ path: info.outputPath('05-moved-with-branches.png') });

  // Delete the middle task: its branch moves up to the plan instead of vanishing.
  await row(page, draft.id).hover();
  await page.getByRole('button', { name: 'Task actions for Draft announcement', exact: true }).click();
  await page.getByRole('menuitem', { name: /Delete task/ }).click();
  await page.getByRole('dialog', { name: 'Delete task “Draft announcement”?' }).getByRole('button', { name: 'Delete task' }).click();
  await expect(row(page, draft.id)).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Branches of Launch plan' }).locator(`[data-task-row="${review.id}"]`)).toBeVisible();
  await expect.poll(async () => (await serverTasks(request, dm.id, f.a.accessToken))['Legal review']?.from).toBe(plan.id);

  // Everything is server-backed: the tree survives a full reload.
  await page.reload();
  await expect(page.getByRole('group', { name: 'Branches of Launch plan' }).locator(`[data-task-row="${review.id}"]`)).toBeVisible();
  await page.screenshot({ path: info.outputPath('06-after-delete-reparented.png') });
});

test('An open tab follows branch moves and reparenting made by another client', async ({ page, request }, info) => {
  test.skip(info.project.name !== 'chromium-desktop', 'Realtime is layout independent');
  const { f, dm, createTask } = await hermesDm(request);
  const plan = await createTask({ title: 'Roadmap' });
  const child = await createTask({ title: 'Roadmap Q1', branchFromThreadId: plan.id });
  const grandchild = await createTask({ title: 'Roadmap Q1 hiring', branchFromThreadId: child.id });
  const project = await call(request, 'POST', `/conversations/projects/${dm.id}`, { name: 'Planning' }, f.a.accessToken);

  await login(page, f.alice);
  await page.goto(`${webURL}/#/dm/${dm.id}?threadId=${grandchild.id}`);
  await expect(row(page, grandchild.id)).toBeVisible();

  // Another client moves and deletes; this tab only listens.
  await call(request, 'PATCH', `/conversations/threads/${dm.id}`, { threadId: plan.id, projectId: project.id }, f.a.accessToken);
  const planning = page.getByRole('group', { name: 'Project Planning' });
  await expect(planning.locator(`[data-task-row="${grandchild.id}"]`)).toBeVisible();
  await expect(page.getByRole('group', { name: 'Tasks without a project' })).toHaveCount(0);

  await call(request, 'DELETE', `/conversations/threads/${dm.id}/${child.id}`, undefined, f.a.accessToken);
  await expect(row(page, child.id)).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Branches of Roadmap' }).locator(`[data-task-row="${grandchild.id}"]`)).toBeVisible();
  // The open branch's lineage follows the new parent.
  const bar = page.getByRole('navigation', { name: 'Task branches' });
  await expect(bar.getByRole('button', { name: 'Roadmap', exact: true })).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Roadmap Q1', exact: true })).toHaveCount(0);
});
