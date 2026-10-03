import { expect, test } from "@playwright/test";
import { createConversation, deleteSelectedConversation, waitForConnected } from "./helpers.js";

test("composer uses two lines and compact controls on desktop and mobile", async ({ page }) => {
  await waitForConnected(page);
  await createConversation(page);
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(input).toHaveAttribute("rows", "2");

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await input.fill("First line");
    await input.press("Shift+Enter");
    await input.pressSequentially("Second line");
    await expect(input).toHaveValue("First line\nSecond line");
    await expect(page.locator(".message-user")).toHaveCount(0);
    const bounds = await input.boundingBox();
    expect(bounds?.height).toBeGreaterThanOrEqual(40);
    expect(bounds?.height).toBeLessThanOrEqual(60);
    expect((await page.locator(".composer").boundingBox())?.height).toBeLessThanOrEqual(110);
    for (const name of ["Attach images", "Send"]) {
      const button = page.getByRole("button", { name, exact: true });
      await expect(button).toBeEnabled();
      await expect(button).toBeInViewport();
      expect((await button.boundingBox())?.height).toBeLessThanOrEqual(30);
    }
  }
  await deleteSelectedConversation(page);
});

test("streaming controls share the smaller button sizing without overflowing", async ({ page }) => {
  await waitForConnected(page);
  await createConversation(page);
  await page.getByRole("textbox", { name: "Message" }).fill("Stream slowly for compact composer controls");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.locator(".header-status")).toContainText("Running");
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const name of ["Attach images", "Steer", "Follow up", "Abort"]) {
      const button = page.getByRole("button", { name, exact: true });
      await expect(button).toBeInViewport();
      expect((await button.boundingBox())?.height).toBeLessThanOrEqual(30);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.getByRole("button", { name: "Abort", exact: true }).click();
  await expect(page.locator(".header-status")).toContainText("Idle");
  await deleteSelectedConversation(page);
});
