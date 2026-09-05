import { expect, test } from "@playwright/test";

import { waitForConnected } from "./helpers.js";

test("typing does not re-render history and drafts survive conversation switches", async ({ page }) => {
  await waitForConnected(page);
  await page.locator(".workspace-picker-row").filter({ hasText: "Thinking and tools" }).click();
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(composer).toBeEnabled();
  await expect(page.locator(".message-markdown")).toContainText("fixture inspection is complete");

  // Count real render work rather than imposing machine-dependent latency limits.
  // Timeline and sidebar rendering construct date formatters; typing must not.
  await page.evaluate(() => {
    const counters = window as typeof window & { historyDateFormats: number };
    counters.historyDateFormats = 0;
    Intl.DateTimeFormat = new Proxy(Intl.DateTimeFormat, {
      construct(target, args) {
        counters.historyDateFormats += 1;
        return Reflect.construct(target, args);
      },
    });
  });
  const draft = "An unsent draft with **formatting**";
  await composer.pressSequentially(draft);
  await expect(composer).toHaveValue(draft);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (
    window as typeof window & { historyDateFormats: number }
  ).historyDateFormats)).toBe(0);

  await page.locator("button.conversation-row").filter({ hasText: "Image behavior" }).click();
  await expect(composer).toHaveValue("");
  await composer.fill("A different conversation's draft");
  await page.locator("button.conversation-row").filter({ hasText: "Thinking and tools" }).click();
  await expect(composer).toHaveValue(draft);
  // Ensure the render-work probe really observes ordinary page renders.
  expect(await page.evaluate(() => (
    window as typeof window & { historyDateFormats: number }
  ).historyDateFormats)).toBeGreaterThan(0);
  await composer.fill("");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
});
