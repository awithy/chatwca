import { expect, test } from "@playwright/test";

import {
  createConversation,
  deleteSelectedConversation,
  submitAndWait,
  waitForConnected,
} from "./helpers.js";

test("creates, edits, selects, and removes a workspace with retention confirmation", async ({ page }) => {
  await waitForConnected(page);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByLabel("Name").fill("Temporary project");
  await page.getByLabel("Directory path").fill("/tmp/chatwca-browser-temporary-project");
  await page.getByRole("button", { name: "Add workspace", exact: true }).click();

  const workspaceRow = page.getByRole("button", { name: /Temporary project.*chatwca-browser-temporary-project/ });
  await expect(workspaceRow).toBeVisible();
  await expect(page.getByRole("heading", { name: "Start in Temporary project" })).toBeVisible();

  await page.getByRole("button", { name: "Workspace actions for Temporary project" }).click();
  await page.getByRole("button", { name: "Edit workspace Temporary project" }).click();
  await page.getByLabel("Name").fill("Renamed project");
  await page.getByLabel("Directory path").fill("/tmp/chatwca-browser-renamed-project");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("button", { name: /Renamed project.*chatwca-browser-renamed-project/ })).toBeVisible();

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("Pi sessions will be retained");
    expect(dialog.message()).toContain("will not be deleted");
    await dialog.accept();
  });
  // The menu remains open so focus can return to the exact Edit action after the modal closes.
  await page.getByRole("button", { name: "Remove workspace Renamed project" }).click();
  await expect(page.getByRole("button", { name: /Renamed project/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Select a workspace" })).toBeVisible();
});

test("create, switch, close, reopen, and delete selected-workspace conversations", async ({ page }) => {
  const alphaPrompt = "Lifecycle alpha conversation";
  const betaPrompt = "Lifecycle beta conversation";

  await waitForConnected(page);
  await createConversation(page);
  await submitAndWait(page, alphaPrompt);
  const sidebarConversations = page.locator(".conversation-list-panel");
  let alphaRow = sidebarConversations.getByRole("button", { name: new RegExp(alphaPrompt) });
  await expect(alphaRow).toContainText("Idle");

  await page.getByRole("button", { name: "Edit conversation title" }).click();
  await page.getByLabel("Conversation title").fill("Custom alpha title");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Custom alpha title" })).toBeVisible();
  alphaRow = sidebarConversations.getByRole("button", { name: /Custom alpha title/ });
  await expect(alphaRow).toBeVisible();

  await page.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
  await submitAndWait(page, betaPrompt);
  const betaRow = sidebarConversations.getByRole("button", { name: new RegExp(betaPrompt) });

  await alphaRow.click();
  await expect(page.locator(".message-user")).toContainText(alphaPrompt);

  await betaRow.click();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Start in Browser workspace" })).toBeVisible();
  await expect(betaRow).toContainText("Closed");

  await betaRow.click();
  await expect(page.locator(".header-status")).toContainText("Idle");
  await expect(page.locator(".message-user")).toContainText(betaPrompt);

  await deleteSelectedConversation(page);
  await expect(betaRow).toHaveCount(0);
  await expect(alphaRow).toBeVisible();

  await alphaRow.click();
  await deleteSelectedConversation(page);
  await expect(alphaRow).toHaveCount(0);
});
