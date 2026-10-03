import { expect, test } from "@playwright/test";
import { createConversation, deleteSelectedConversation, waitForConnected } from "./helpers.js";

test("compact header keeps details and actions in a keyboard-operable ellipsis disclosure", async ({ page }) => {
  await waitForConnected(page);
  await createConversation(page);
  const header = page.locator(".conversation-header");
  const trigger = header.getByRole("button", { name: "More conversation actions" });
  const popover = header.getByRole("group", { name: "Conversation details and actions" });

  await expect(header.getByRole("button", { name: "New", exact: true })).toBeHidden();
  await expect(header.getByRole("button", { name: "Edit conversation title" })).toBeHidden();
  await expect(header.locator(".security-badge")).toBeVisible();
  await expect(header.locator(".header-status")).toContainText("Idle");
  for (const width of [1280, 900, 800]) {
    await page.setViewportSize({ width, height: 720 });
    const bounds = await header.boundingBox();
    expect(bounds?.height).toBeLessThanOrEqual(36);
    await expect(trigger).toBeInViewport();
  }

  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(popover).toBeVisible();
  await expect(popover).toContainText("/tmp/chatwca-browser-workspace");
  await expect(popover).toContainText("Model");
  await page.keyboard.press("Tab");
  await expect(header.getByRole("button", { name: "Edit conversation title" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await page.getByRole("textbox", { name: "Message" }).click();
  await expect(popover).toBeHidden();

  await trigger.click();
  await header.getByRole("button", { name: "Edit conversation title" }).click();
  await expect(popover).toBeHidden();
  await expect(page.getByLabel("Conversation title", { exact: true })).toBeFocused();
  await page.getByLabel("Conversation title", { exact: true }).fill("Compact conversation");
  await header.getByRole("button", { name: "Save", exact: true }).click();
  await expect(header.getByRole("heading", { name: "Compact conversation" })).toBeVisible();
  await expect(trigger).toBeFocused();
  await deleteSelectedConversation(page);
});

test("actions preserve active-run restrictions inside the disclosure", async ({ page }) => {
  await waitForConnected(page);
  await createConversation(page);
  await page.getByRole("textbox", { name: "Message" }).fill("Stream slowly for compact header controls");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".header-status")).toContainText("Running");
  await page.getByRole("button", { name: "More conversation actions" }).click();
  const actions = page.locator(".conversation-actions-popover");
  await expect(actions.getByRole("button", { name: "Close", exact: true })).toBeDisabled();
  await expect(actions.getByRole("button", { name: "Delete", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Abort", exact: true }).click();
  await expect(page.locator(".header-status")).toContainText("Idle");
  await deleteSelectedConversation(page);
});
