import { expect, test, type Page, type WebSocket as PlaywrightWebSocket } from "@playwright/test";

import { waitForConnected } from "./helpers.js";

interface SentFrame {
  readonly type?: string;
  readonly name?: string;
  readonly networkPolicySetId?: string;
  readonly acknowledgeNetworkExposure?: boolean;
  readonly acknowledgeSecurityDowngrade?: boolean;
  readonly allowedDomains?: unknown;
  readonly allowedPorts?: unknown;
}

function captureSent(page: Page): SentFrame[] {
  const sent: SentFrame[] = [];
  page.on("websocket", (socket: PlaywrightWebSocket) => {
    socket.on("framesent", ({ payload }) => {
      if (typeof payload === "string") sent.push(JSON.parse(payload) as SentFrame);
    });
  });
  return sent;
}

async function createManaged(page: Page, name: string, path: string, setId = "default"): Promise<void> {
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add workspace" });
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByLabel("Directory path").fill(path);
  await dialog.getByLabel("Security profile", { exact: true }).selectOption("workspace-sandboxed");
  await dialog.getByLabel("Sandbox network", { exact: true }).selectOption("managed-egress");
  await dialog.getByLabel("Destination policy", { exact: true }).selectOption(setId);
  page.once("dialog", (confirmation) => confirmation.accept());
  await dialog.getByRole("button", { name: "Add workspace" }).click();
  await expect(dialog).toHaveCount(0);
}

async function openEdit(page: Page, name: string) {
  await page.getByRole("button", { name: `Workspace actions for ${name}` }).click();
  const trigger = page.getByRole("button", { name: `Edit workspace ${name}` });
  await trigger.click();
  return { trigger, dialog: page.getByRole("dialog", { name: "Edit workspace" }) };
}

test("workspace modal traps focus, closes with Escape, restores exact triggers, and makes the page inert", async ({ page }) => {
  await waitForConnected(page);
  const add = page.getByRole("button", { name: "Add", exact: true });
  await add.click();
  const dialog = page.getByRole("dialog", { name: "Add workspace" });
  const name = dialog.getByLabel("Name");

  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(name).toBeFocused();
  expect(await page.locator("#root").evaluate((root) => (root as HTMLElement).inert)).toBe(true);
  await name.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Add workspace" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(name).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(add).toBeFocused();
  expect(await page.locator("#root").evaluate((root) => (root as HTMLElement).inert)).toBe(false);

  await page.getByRole("button", { name: "Workspace actions for Browser workspace" }).click();
  const editTrigger = page.getByRole("button", { name: "Edit workspace Browser workspace" });
  await editTrigger.click();
  await expect(page.getByRole("dialog", { name: "Edit workspace" })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Edit workspace" }).getByLabel("Name")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(editTrigger).toBeFocused();
});

test("validation is associated and focused, pending submission cannot be cancelled, and narrow actions remain visible", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await waitForConnected(page);
  await page.getByRole("button", { name: "Open workspaces and conversations" }).click();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add workspace" });
  await dialog.getByRole("button", { name: "Add workspace" }).click();
  const name = dialog.getByLabel("Name");
  const errorId = await name.getAttribute("aria-describedby");
  expect(errorId).toBeTruthy();
  await expect(page.locator(`#${errorId!}`)).toHaveText("Enter a workspace name.");
  await expect(name).toBeFocused();

  const box = await dialog.boundingBox();
  expect(box?.x).toBeGreaterThanOrEqual(0);
  expect(box?.y).toBeGreaterThanOrEqual(0);
  expect(box?.height).toBeLessThanOrEqual(700);
  await expect(dialog.getByRole("heading", { name: "Add workspace" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Add workspace" })).toBeVisible();

  await name.fill("Slow modal project");
  await dialog.getByLabel("Directory path").fill("/tmp/chatwca-fixture-slow-submit");
  await dialog.getByRole("button", { name: "Add workspace" }).click();
  await expect(dialog.getByRole("button", { name: "Adding…" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCount(0, { timeout: 3_000 });
});

test("confirmation retains selected disclosure and sends only the exact named-set payload", async ({ page }) => {
  const sent = captureSent(page);
  await waitForConnected(page);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add workspace" });
  await dialog.getByLabel("Name").fill("Retained confirmation policy");
  await dialog.getByLabel("Directory path").fill("/tmp/chatwca-retained-confirmation-policy");
  await dialog.getByLabel("Security profile", { exact: true }).selectOption("workspace-sandboxed");
  await dialog.getByLabel("Sandbox network", { exact: true }).selectOption("managed-egress");
  await dialog.getByLabel("Destination policy", { exact: true }).selectOption("web");
  await expect(dialog).toContainText("**.example.com");
  await expect(dialog).toContainText("80, 443");

  page.once("dialog", (confirmation) => confirmation.dismiss());
  await dialog.getByRole("button", { name: "Add workspace" }).click();
  await expect(dialog.getByLabel("Name")).toHaveValue("Retained confirmation policy");
  await expect(dialog.getByLabel("Destination policy", { exact: true })).toHaveValue("web");
  await expect(dialog).toContainText("**.example.com");

  page.once("dialog", (confirmation) => confirmation.accept());
  await dialog.getByRole("button", { name: "Add workspace" }).click();
  const frame = sent.find(({ type, name }) => type === "workspace.create" && name === "Retained confirmation policy");
  expect(frame).toMatchObject({ networkPolicySetId: "web" });
  expect(frame).not.toHaveProperty("acknowledgeNetworkExposure");
  expect(frame).not.toHaveProperty("allowedDomains");
  expect(frame).not.toHaveProperty("allowedPorts");
});

test("unavailable sets fail visibly and can be explicitly replaced with acknowledged exact updates", async ({ page }) => {
  const sent = captureSent(page);
  await waitForConnected(page);
  const name = "Unavailable destination policy";
  await createManaged(page, name, "/tmp/chatwca-fixture-policy-set-unavailable", "web");
  const { dialog, trigger } = await openEdit(page, name);

  await expect(dialog.getByLabel("Destination policy", { exact: true })).toHaveValue("retired-policy");
  await expect(dialog).toContainText("retired-policy — unavailable");
  await expect(dialog).toContainText("Select a replacement or switch to Isolated");
  await dialog.getByLabel("Destination policy", { exact: true }).selectOption("default");
  page.once("dialog", (confirmation) => confirmation.accept());
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  const frame = sent.find(({ type, name: frameName }) => type === "workspace.update" && frameName === name);
  expect(frame).toMatchObject({
    networkPolicySetId: "default",
    acknowledgeNetworkExposure: true,
  });
  expect(frame).not.toHaveProperty("allowedDomains");
  expect(frame).not.toHaveProperty("allowedPorts");
});

test("security downgrade and managed-set changes require separate retained confirmations", async ({ page }) => {
  const sent = captureSent(page);
  await waitForConnected(page);
  const name = "Separate confirmations project";
  await createManaged(page, name, "/tmp/chatwca-separate-confirmations");
  const { dialog } = await openEdit(page, name);
  await dialog.getByLabel("Destination policy", { exact: true }).selectOption("web");
  await dialog.getByLabel("Security profile", { exact: true }).selectOption("unrestricted");

  const messages: string[] = [];
  page.on("dialog", async (confirmation) => {
    messages.push(confirmation.message());
    await confirmation.accept();
  });
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toHaveCount(0);
  expect(messages).toHaveLength(2);
  expect(messages[0]).toContain("Workspace sandbox to Unrestricted");
  expect(messages[1]).toContain("Enable or change Managed egress");
  const frame = sent.find(({ type, name: frameName }) => type === "workspace.update" && frameName === name);
  expect(frame).toMatchObject({
    networkPolicySetId: "web",
    acknowledgeNetworkExposure: true,
    acknowledgeSecurityDowngrade: true,
  });
});

test("a live managed workspace locks path, profile, network type, and destination set but permits its name", async ({ page }) => {
  await waitForConnected(page);
  const name = "Live managed lock project";
  await createManaged(page, name, "/tmp/chatwca-live-managed-lock", "web");
  await page.getByRole("button", { name: `New conversation in ${name}` }).click();
  const { dialog } = await openEdit(page, name);

  await expect(dialog.getByLabel("Name")).toBeEnabled();
  await expect(dialog.getByLabel("Directory path")).toBeDisabled();
  await expect(dialog.getByLabel("Security profile", { exact: true })).toBeDisabled();
  await expect(dialog.getByLabel("Sandbox network", { exact: true })).toBeDisabled();
  await expect(dialog.getByLabel("Destination policy", { exact: true })).toBeDisabled();
  await expect(dialog).toContainText("security profile, network type, or destination policy");
});
