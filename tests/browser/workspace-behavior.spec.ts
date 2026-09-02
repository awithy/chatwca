import { expect, test, type Page, type WebSocket as PlaywrightWebSocket } from "@playwright/test";

import { submitAndWait, waitForConnected } from "./helpers.js";

interface WireMessage {
  readonly type?: string;
  readonly workspaceId?: string;
  readonly workspaces?: readonly { readonly id: string; readonly name: string }[];
}

function captureFrames(page: Page): {
  readonly sent: WireMessage[];
  readonly received: WireMessage[];
} {
  const sent: WireMessage[] = [];
  const received: WireMessage[] = [];
  page.on("websocket", (socket: PlaywrightWebSocket) => {
    socket.on("framesent", ({ payload }) => {
      if (typeof payload === "string") sent.push(JSON.parse(payload) as WireMessage);
    });
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload === "string") received.push(JSON.parse(payload) as WireMessage);
    });
  });
  return { sent, received };
}

async function addWorkspace(
  page: Page,
  name: string,
  directoryPath: string,
  storeSessionsInWorkspace = false,
): Promise<void> {
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Directory path").fill(directoryPath);
  if (storeSessionsInWorkspace) {
    await page.getByLabel("Store sessions in this workspace").check();
  }
  await page.getByRole("button", { name: "Add workspace", exact: true }).click();
  await expect(page.locator("button.workspace-select-button").filter({ hasText: name })).toBeVisible();
}

async function createSelectedConversation(
  page: Page,
  workspaceName: string,
  workspacePath: string,
): Promise<void> {
  await page.getByRole("button", { name: `New conversation in ${workspaceName}` }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
  await expect(page.locator(".conversation-workspace-path")).toContainText(workspacePath);
}

test("does not request Pi history before a workspace is selected", async ({ page }) => {
  const frames = captureFrames(page);
  await page.goto("/");
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Browser workspace/ }).first()).toBeVisible();

  await expect.poll(() => frames.sent.map(({ type }) => type)).toContain("workspace.list");
  expect(frames.sent.some(({ type }) => type === "history.list")).toBe(false);
  await expect(page.getByText("Select a workspace to load its conversations.")).toBeVisible();

  await page.getByRole("button", { name: /Browser workspace/ }).first().click();
  await expect.poll(() => frames.sent.filter(({ type }) => type === "history.list")).toHaveLength(1);
});

test("orders workspaces by most recently selected", async ({ page }) => {
  await waitForConnected(page);
  await addWorkspace(page, "Recent workspace A", "/tmp/chatwca-recent-a");
  await addWorkspace(page, "Recent workspace B", "/tmp/chatwca-recent-b");

  const items = page.locator(".workspace-item");
  await expect(items.first()).toContainText("Recent workspace B");

  await page.getByRole("button", { name: /Recent workspace A.*chatwca-recent-a/ }).click();
  await expect(items.first()).toContainText("Recent workspace A");
  await expect(items.nth(1)).toContainText("Recent workspace B");
});

test("opens the most recent conversation when changing workspaces", async ({ page }) => {
  const olderPrompt = "Older workspace conversation";
  const latestPrompt = "Most recent workspace conversation";

  await waitForConnected(page);
  await addWorkspace(page, "Recent conversations", "/tmp/chatwca-recent-conversations");
  await createSelectedConversation(
    page,
    "Recent conversations",
    "/tmp/chatwca-recent-conversations",
  );
  await submitAndWait(page, olderPrompt);
  await createSelectedConversation(
    page,
    "Recent conversations",
    "/tmp/chatwca-recent-conversations",
  );
  await submitAndWait(page, latestPrompt);

  await addWorkspace(page, "Workspace switch target", "/tmp/chatwca-switch-target");
  await expect(page.getByRole("heading", { name: "Start in Workspace switch target" })).toBeVisible();

  await page.getByRole("button", { name: /Recent conversations.*chatwca-recent-conversations/ }).click();

  await expect(page.locator(".message-user")).toContainText(latestPrompt);
  await expect(page.locator(".message-user")).not.toContainText(olderPrompt);
  await expect(page.getByRole("button", { name: new RegExp(latestPrompt) })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("creates immutable workspace-local storage and shows it in workspace info", async ({ page }) => {
  const name = "Local session project";
  const directoryPath = "/tmp/chatwca-local-session-project";
  await waitForConnected(page);
  await addWorkspace(page, name, directoryPath, true);

  await page.getByRole("button", { name: `Workspace actions for ${name}` }).click();
  await page.getByRole("button", { name: `Workspace info ${name}` }).click();
  const info = page.getByRole("region", { name: `Workspace info for ${name}` });
  await expect(info).toContainText("Stored in workspace");
  await expect(info).toContainText(`${directoryPath}/.chatwca/sessions`);
  await info.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: `Workspace actions for ${name}` }).click();
  await page.getByRole("button", { name: `Edit workspace ${name}` }).click();
  await expect(page.getByLabel("Store sessions in this workspace")).toHaveCount(0);
});

test("marks an unavailable workspace and disables path-dependent actions", async ({ page }) => {
  await waitForConnected(page);
  await addWorkspace(
    page,
    "Unavailable project",
    "/tmp/chatwca-fixture-unavailable-project",
  );

  const workspace = page.getByRole("button", { name: /Unavailable project.*Unavailable/ });
  await expect(workspace).toBeVisible();
  await expect(page.getByRole("heading", { name: "Workspace unavailable" })).toBeVisible();
  await expect(page.getByRole("button", { name: /New conversation in Unavailable project/ })).toBeDisabled();

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Workspace actions for Unavailable project" }).click();
  await page.getByRole("button", { name: "Remove workspace Unavailable project" }).click();
  await expect(workspace).toHaveCount(0);
});

test("isolates workspace histories while a run continues in the background", async ({ page }) => {
  const backgroundPrompt = "Background stream slowly in isolated workspace A";
  const foregroundPrompt = "Workspace B owns this conversation";

  await waitForConnected(page);
  await addWorkspace(page, "Isolated A", "/tmp/chatwca-isolated-a");
  await createSelectedConversation(page, "Isolated A", "/tmp/chatwca-isolated-a");
  await page.getByRole("textbox", { name: "Message" }).fill(backgroundPrompt);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".header-status")).toContainText("Running");

  await addWorkspace(page, "Isolated B", "/tmp/chatwca-isolated-b");
  await expect(page.getByRole("heading", { name: "Start in Isolated B" })).toBeVisible();
  await expect(page.getByRole("button", { name: new RegExp(backgroundPrompt) })).toHaveCount(0);
  await createSelectedConversation(page, "Isolated B", "/tmp/chatwca-isolated-b");
  await submitAndWait(page, foregroundPrompt);

  await page.getByRole("button", { name: /Isolated A.*chatwca-isolated-a/ }).click();
  await expect(page.getByRole("button", { name: new RegExp(foregroundPrompt) })).toHaveCount(0);
  await expect(page.getByRole("button", { name: new RegExp(backgroundPrompt) })).toContainText("Idle", {
    timeout: 4_000,
  });
  await page.getByRole("button", { name: new RegExp(backgroundPrompt) }).click();
  await expect(page.locator(".message-assistant").last()).toContainText(
    `Deterministic response to: ${backgroundPrompt}`,
  );
});

test("rejects out-of-order history after rapid workspace switching", async ({ page }) => {
  const frames = captureFrames(page);
  const sourcePrompt = "Out-of-order source conversation";

  await waitForConnected(page);
  await addWorkspace(page, "History source", "/tmp/chatwca-out-of-order-source");
  await createSelectedConversation(page, "History source", "/tmp/chatwca-out-of-order-source");
  await submitAndWait(page, sourcePrompt);
  await addWorkspace(page, "History target", "/tmp/chatwca-out-of-order-target");
  await expect(page.getByRole("heading", { name: "Start in History target" })).toBeVisible();

  const latestWorkspaces = [...frames.received].reverse().find(
    (message) => message.type === "workspaces" && message.workspaces !== undefined,
  )?.workspaces;
  const sourceId = latestWorkspaces?.find(({ name }) => name === "History source")?.id;
  const targetId = latestWorkspaces?.find(({ name }) => name === "History target")?.id;
  expect(sourceId).toBeDefined();
  expect(targetId).toBeDefined();

  frames.received.splice(0);
  await page.getByRole("button", { name: /History source.*out-of-order-source/ }).click();
  await page.getByRole("button", { name: /History target.*out-of-order-target/ }).click();

  await expect.poll(() => frames.received
    .filter(({ type }) => type === "history")
    .map(({ workspaceId }) => workspaceId)).toEqual(expect.arrayContaining([targetId, sourceId]));
  await expect.poll(() => {
    const historyIds = frames.received
      .filter(({ type }) => type === "history")
      .map(({ workspaceId }) => workspaceId);
    const targetIndex = historyIds.lastIndexOf(targetId);
    return targetIndex >= 0 && historyIds.slice(targetIndex + 1).includes(sourceId);
  }).toBe(true);

  await expect(page.getByRole("heading", { name: "Start in History target" })).toBeVisible();
  await expect(page.getByRole("button", { name: new RegExp(sourcePrompt) })).toHaveCount(0);
});

test("busy workspace mutation is rejected and removal retains closed sessions", async ({ page }) => {
  const workspaceName = "Retained project";
  const workspacePath = "/tmp/chatwca-retained-project";
  const prompt = "Session retained after workspace removal";

  await waitForConnected(page);
  await addWorkspace(page, workspaceName, workspacePath);
  await createSelectedConversation(page, workspaceName, workspacePath);
  await submitAndWait(page, prompt);

  await page.getByRole("button", { name: `Workspace actions for ${workspaceName}` }).click();
  await page.getByRole("button", { name: `Edit workspace ${workspaceName}` }).click();
  await expect(page.getByLabel("Name")).toBeEnabled();
  await expect(page.getByLabel("Directory path")).toBeDisabled();
  await expect(page.getByLabel("Security profile", { exact: true })).toBeDisabled();
  await expect(page.getByText("Close this workspace’s live conversations")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  page.once("dialog", (dialog) => dialog.accept());
  // Cancel restores focus to the still-open Edit action menu.
  await page.getByRole("button", { name: `Remove workspace ${workspaceName}` }).click();
  await expect(page.getByRole("alert")).toContainText("Close the workspace's live conversations");

  await page.getByRole("button", { name: "Close", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: `Workspace actions for ${workspaceName}` }).click();
  await page.getByRole("button", { name: `Remove workspace ${workspaceName}` }).click();
  await expect(page.locator("button.workspace-select-button").filter({ hasText: workspaceName })).toHaveCount(0);

  await addWorkspace(page, workspaceName, workspacePath);
  const retained = page.getByRole("button", { name: new RegExp(prompt) });
  await expect(retained).toContainText("Idle");
  await expect(retained).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".message-user")).toContainText(prompt);
});
