import { expect, type Page } from "@playwright/test";

export const DEFAULT_WORKSPACE_PATH = "/tmp/chatwca-browser-workspace";

export async function waitForConnected(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  const mobileMenu = page.getByRole("button", { name: "Open workspaces and conversations" });
  if (await mobileMenu.isVisible()) await mobileMenu.click();
  await page.getByRole("button", { name: /Browser workspace/ }).first().click();
  await expect(page.getByRole("heading", { name: "Start in Browser workspace" })).toBeVisible();
}

export async function createConversation(page: Page): Promise<void> {
  await page.getByRole("button", { name: /New conversation in Browser workspace/ }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
  await expect(page.locator(".conversation-workspace-path")).toContainText(
    DEFAULT_WORKSPACE_PATH,
  );
}

export async function submitAndWait(
  page: Page,
  prompt: string,
): Promise<void> {
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill(prompt);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".header-status")).toContainText("Running");
  await expect(page.locator(".message-assistant").last()).toContainText(
    `Deterministic response to: ${prompt}`,
  );
  await expect(page.locator(".header-status")).toContainText("Idle");
}

export async function deleteSelectedConversation(page: Page): Promise<void> {
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Start in Browser workspace" })).toBeVisible();
}
