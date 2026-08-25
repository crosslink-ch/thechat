import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const enabled = process.env.TASK_PROJECTS_E2E === "1";
const describeTaskProjects = enabled ? describe : describe.skip;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function findProjectGroup(name) {
  return $(
    `//*[@data-testid and starts-with(@data-testid, 'hermes-project-')][.//span[normalize-space(text())='${name}']]`,
  );
}

async function projectContainsTask(projectName, taskTitle) {
  const task = await $(
    `//*[@data-testid and starts-with(@data-testid, 'hermes-project-')][.//span[normalize-space(text())='${projectName}']]//span[normalize-space(text())='${taskTitle}']`,
  );
  return task.isDisplayed();
}

async function createProject(name, color) {
  await $("button[aria-label='New project']").click();
  const input = await $("input[placeholder='Project name']");
  await input.waitForDisplayed({ timeout: 5_000 });
  await input.setValue(name);
  await $(`button[aria-label='Use ${color}']`).click();
  const createButton = await $("button=Create project");
  await createButton.waitForClickable({ timeout: 5_000 });
  await createButton.click();
  try {
    await browser.waitUntil(
      async () => {
        try {
          return await (await findProjectGroup(name)).isDisplayed();
        } catch {
          return false;
        }
      },
      { timeout: 10_000, timeoutMsg: `Project was not created: ${name}` },
    );
  } catch (error) {
    const alerts = [];
    for (const alert of await $$("[role='alert']")) {
      if (await alert.isDisplayed()) alerts.push(await alert.getText());
    }
    const invokes = await browser.execute(
      () => window.__taskProjectNetworkRecords?.tauriInvokes ?? [],
    );
    const bodyText = await $("body").getText();
    const sqlite = readSqliteEvidence();
    const debugScreenshot = path.join(
      path.dirname(required("TASK_PROJECTS_E2E_SCREENSHOT_ORGANIZED")),
      "task-projects-debug.png",
    );
    await browser.saveScreenshot(debugScreenshot);
    throw new Error(
      `${error.message}; alerts=${JSON.stringify(alerts)}; invokes=${JSON.stringify(invokes)}; sqlite=${JSON.stringify(sqlite.rows)}; body=${JSON.stringify(bodyText.slice(-1200))}; screenshot=${debugScreenshot}`,
    );
  }
}

async function moveTask(title, projectName) {
  const taskRow = await $(
    `//button[@aria-label='Organize ${title}']/parent::div`,
  );
  await taskRow.moveTo();
  const trigger = await $(`button[aria-label="Organize ${title}"]`);
  await trigger.waitForClickable({ timeout: 10_000 });
  await trigger.click();
  const item = await $(
    `//*[@role='menuitem' and .//*[normalize-space(text())='${projectName}']]`,
  );
  await item.waitForClickable({ timeout: 5_000 });
  await item.click();
  try {
    await browser.waitUntil(
      async () => projectContainsTask(projectName, title),
      {
        timeout: 10_000,
        timeoutMsg: `Task '${title}' did not move into '${projectName}'`,
      },
    );
  } catch (error) {
    const sqlite = readSqliteEvidence();
    const groupText = await (await findProjectGroup(projectName)).getText();
    throw new Error(
      `${error.message}; sqlite=${JSON.stringify(sqlite.rows)}; group=${JSON.stringify(groupText)}`,
    );
  }
}

function readSqliteEvidence() {
  const dataDir = required("THECHAT_DATA_DIR");
  const database = path.join(dataDir, "thechat.db");
  const query = `
    SELECT p.name AS project_name,
           p.color,
           a.thread_id
    FROM hermes_task_projects p
    LEFT JOIN hermes_task_project_assignments a
      ON a.project_id = p.id
     AND a.user_id = p.user_id
     AND a.conversation_id = p.conversation_id
    ORDER BY p.position, a.thread_id;
  `;
  const python = [
    "import json, sqlite3, sys",
    "connection = sqlite3.connect(sys.argv[1])",
    "connection.row_factory = sqlite3.Row",
    "rows = [dict(row) for row in connection.execute(sys.argv[2])]",
    "print(json.dumps(rows))",
  ].join("; ");
  const output = execFileSync(
    process.env.PYTHON ?? "python3",
    ["-c", python, database, query],
    {
      encoding: "utf8",
    },
  ).trim();
  return {
    database,
    rows: output ? JSON.parse(output) : [],
  };
}

async function installBoundaryRecorder() {
  await browser.execute(() => {
    const records = {
      fetches: [],
      xhrs: [],
      tauriInvokes: [],
      websocketSends: [],
    };
    const originalFetch = window.fetch.bind(window);
    window.fetch = (...args) => {
      const input = args[0];
      const init = args[1];
      records.fetches.push({
        url: typeof input === "string" ? input : input.url,
        method:
          init?.method ?? (typeof input === "string" ? "GET" : input.method),
      });
      return originalFetch(...args);
    };
    const originalXhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      records.xhrs.push({ method, url: String(url) });
      return originalXhrOpen.call(this, method, url, ...rest);
    };
    const tauriInternals = window.__TAURI_INTERNALS__;
    if (tauriInternals?.invoke) {
      const originalInvoke = tauriInternals.invoke.bind(tauriInternals);
      tauriInternals.invoke = (command, args, options) => {
        records.tauriInvokes.push(String(command));
        return originalInvoke(command, args, options);
      };
    }
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      let type = "<binary>";
      if (typeof data === "string") {
        try {
          type = JSON.parse(data).type ?? "<json-without-type>";
        } catch {
          type = "<non-json>";
        }
      }
      records.websocketSends.push({ type });
      return originalSend.call(this, data);
    };
    window.__taskProjectNetworkRecords = records;
  });
}

async function boundaryRecords() {
  return browser.execute(() => ({
    fetches: [...window.__taskProjectNetworkRecords.fetches],
    xhrs: [...window.__taskProjectNetworkRecords.xhrs],
    tauriInvokes: [...window.__taskProjectNetworkRecords.tauriInvokes],
    websocketSends: [...window.__taskProjectNetworkRecords.websocketSends],
  }));
}

describeTaskProjects("local Hermes task projects", () => {
  it("organizes tasks locally and restores the project layout after a renderer restart", async function () {
    this.timeout(240_000);

    const email = required("TASK_PROJECTS_E2E_EMAIL");
    const password = required("TASK_PROJECTS_E2E_PASSWORD");
    const botName = required("TASK_PROJECTS_E2E_BOT_NAME");
    const conversationId = required("TASK_PROJECTS_E2E_CONVERSATION_ID");
    const threadIds = JSON.parse(required("TASK_PROJECTS_E2E_THREAD_IDS"));
    const screenshotOrganized = path.resolve(
      required("TASK_PROJECTS_E2E_SCREENSHOT_ORGANIZED"),
    );
    const screenshotMenu = path.resolve(
      required("TASK_PROJECTS_E2E_SCREENSHOT_MENU"),
    );
    const evidencePath = path.resolve(required("TASK_PROJECTS_E2E_EVIDENCE"));
    const buildEvidencePath = path.resolve(
      required("TASK_PROJECTS_E2E_BUILD_EVIDENCE"),
    );

    await browser.setWindowSize(1440, 900);
    const emailInput = await $("#auth-email");
    await emailInput.waitForDisplayed({ timeout: 30_000 });
    const submitButton = await $("form button[type='submit']");
    if ((await submitButton.getText()) !== "Log in") {
      await $("button=Log in").click();
      await browser.waitUntil(
        async () => (await submitButton.getText()) === "Log in",
      );
    }
    await emailInput.setValue(email);
    await $("#auth-password").setValue(password);
    await submitButton.click();
    await emailInput.waitForExist({ reverse: true, timeout: 30_000 });

    await browser.execute((id) => {
      window.location.hash = `#/dm/${id}`;
    }, conversationId);
    await $("[data-testid='hermes-dm-chat-scroll']").waitForDisplayed({
      timeout: 30_000,
    });
    await $(`//*[normalize-space(text())='${botName}']`).waitForDisplayed({
      timeout: 30_000,
    });
    for (const title of Object.keys(threadIds)) {
      await $(
        `//button[.//span[normalize-space(text())='${title}']]`,
      ).waitForDisplayed({
        timeout: 30_000,
      });
    }

    await installBoundaryRecorder();
    await createProject("Website launch", "Violet");
    await createProject("Research & planning", "Cyan");
    await moveTask("Polish launch page", "Website launch");
    await moveTask("Prepare launch checklist", "Website launch");
    await moveTask("Interview beta users", "Research & planning");
    await moveTask("Summarize feedback", "Research & planning");

    const operationBoundary = await boundaryRecords();
    const backendWrites = [
      ...operationBoundary.fetches,
      ...operationBoundary.xhrs,
    ].filter(
      ({ method, url }) =>
        method !== "GET" && !String(url).startsWith("ipc://"),
    );
    expect(backendWrites).toEqual([]);
    expect(
      operationBoundary.websocketSends.filter(({ type }) =>
        ["send_message", "create_thread", "update_thread"].includes(type),
      ),
    ).toEqual([]);
    expect(
      [...operationBoundary.fetches, ...operationBoundary.xhrs]
        .filter(({ url }) => String(url).startsWith("ipc://"))
        .map(({ url }) => new URL(url).pathname.slice(1)),
    ).toEqual([
      "create_hermes_task_project",
      "create_hermes_task_project",
      "assign_hermes_task_to_project",
      "assign_hermes_task_to_project",
      "assign_hermes_task_to_project",
      "assign_hermes_task_to_project",
    ]);

    const sqlite = readSqliteEvidence();
    const projectRows = sqlite.rows.filter((row) => row.thread_id);
    expect(
      sqlite.rows.filter((row) => row.project_name === "Website launch"),
    ).toHaveLength(2);
    expect(
      sqlite.rows.filter((row) => row.project_name === "Research & planning"),
    ).toHaveLength(2);
    expect(new Set(projectRows.map((row) => row.thread_id))).toEqual(
      new Set([
        threadIds["Polish launch page"],
        threadIds["Prepare launch checklist"],
        threadIds["Interview beta users"],
        threadIds["Summarize feedback"],
      ]),
    );

    // A full WebView reload destroys React state. The groups can only return by
    // reading the installation-local SQLite database through Tauri.
    await browser.refresh();
    await $("[data-testid='hermes-dm-chat-scroll']").waitForDisplayed({
      timeout: 30_000,
    });
    await browser.waitUntil(
      async () => {
        try {
          return projectContainsTask("Website launch", "Polish launch page");
        } catch {
          return false;
        }
      },
      { timeout: 30_000, timeoutMsg: "Projects did not rehydrate from SQLite" },
    );

    fs.mkdirSync(path.dirname(screenshotOrganized), { recursive: true });
    await browser.saveScreenshot(screenshotOrganized);

    const unfiledRow = await $(
      "//button[@aria-label='Organize Review analytics']/parent::div",
    );
    await unfiledRow.moveTo();
    const unfiledMenu = await $(
      "button[aria-label='Organize Review analytics']",
    );
    await unfiledMenu.click();
    await $(
      "//*[@role='menu' and .//*[normalize-space(text())='Move to']]",
    ).waitForDisplayed({
      timeout: 5_000,
    });
    await browser.saveScreenshot(screenshotMenu);

    const buildEvidence = JSON.parse(
      fs.readFileSync(buildEvidencePath, "utf8"),
    );
    fs.writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          ok: true,
          binding: buildEvidence,
          conversationId,
          threadIds,
          localOperationBoundary: operationBoundary,
          sqlite,
          screenshots: [screenshotOrganized, screenshotMenu],
        },
        null,
        2,
      ),
    );
  });
});
