import { expect, test } from "@playwright/test";

import {
  createConversation,
  deleteSelectedConversation,
  waitForConnected,
} from "./helpers.js";

test("streams text while its background sidebar status remains authoritative", async ({ page }) => {
  const prompt = "Keep streaming in background";
  await waitForConnected(page);
  await createConversation(page);

  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill(prompt);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".header-status")).toContainText("Running");
  await expect(page.locator(".message-assistant").last()).toContainText("Deterministic response");

  const backgroundRow = page.getByRole("button", { name: new RegExp(prompt) });
  await page.getByRole("button", { name: /Image behavior/ }).click();
  await expect(page.getByRole("heading", { name: "Image behavior" })).toBeVisible();
  await expect(backgroundRow).toContainText("Running");
  await expect(backgroundRow).toContainText("Idle", { timeout: 3_000 });

  await backgroundRow.click();
  await expect(page.locator(".message-assistant").last()).toContainText(
    `Deterministic response to: ${prompt}`,
  );
  await deleteSelectedConversation(page);
});

test("thinking and linked tool details are collapsed until explicitly expanded", async ({ page }) => {
  await waitForConnected(page);
  await page.getByRole("button", { name: /Thinking and tools/ }).click();

  const thinking = page.locator("details.thinking-block");
  const tool = page.locator("details.tool-call-card");
  await expect(thinking).not.toHaveAttribute("open", "");
  await expect(tool).not.toHaveAttribute("open", "");
  await expect(thinking.locator(".thinking-content")).toBeHidden();
  await expect(tool.locator(".tool-card-body")).toBeHidden();

  await thinking.locator("summary").click();
  await expect(thinking).toHaveAttribute("open", "");
  await expect(thinking.locator(".thinking-content")).toContainText("deterministic reasoning");

  await tool.locator("summary").click();
  await expect(tool).toHaveAttribute("open", "");
  await expect(tool.getByText("deterministic tool output")).toBeVisible();
  await tool.locator("summary").click();
  await expect(tool.locator(".tool-card-body")).toBeHidden();
});
