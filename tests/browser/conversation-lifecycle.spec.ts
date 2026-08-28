import { expect, test } from "@playwright/test";

import {
  createConversation,
  deleteSelectedConversation,
  submitAndWait,
  waitForConnected,
} from "./helpers.js";

test("create, switch, close, reopen, and delete persisted conversations", async ({ page }) => {
  const alphaCwd = "/tmp/chatwca-browser-lifecycle-alpha";
  const betaCwd = "/tmp/chatwca-browser-lifecycle-beta";
  const alphaPrompt = "Lifecycle alpha conversation";
  const betaPrompt = "Lifecycle beta conversation";

  await waitForConnected(page);
  await createConversation(page, alphaCwd);
  await submitAndWait(page, alphaPrompt);
  const alphaRow = page.getByRole("button", { name: new RegExp(alphaPrompt) });
  await expect(alphaRow).toContainText("Idle");

  await createConversation(page, betaCwd);
  await submitAndWait(page, betaPrompt);
  const betaRow = page.getByRole("button", { name: new RegExp(betaPrompt) });

  await alphaRow.click();
  await expect(page.locator(".conversation-cwd")).toContainText(alphaCwd);
  await expect(page.locator(".message-user")).toContainText(alphaPrompt);

  await betaRow.click();
  await expect(page.locator(".conversation-cwd")).toContainText(betaCwd);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Start a conversation" })).toBeVisible();
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
