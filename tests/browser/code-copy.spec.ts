import { expect, test } from "@playwright/test";

import { waitForConnected } from "./helpers.js";

const firstCode = 'const message = "<hello> & goodbye";\n  console.log(message);\n';

test.beforeEach(async ({ page }) => {
  await waitForConnected(page);
  await page.locator(".workspace-picker-row").filter({ hasText: "Thinking and tools" }).click();
});

test("copies only the selected block's exact text with keyboard-accessible feedback", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const blocks = page.locator(".code-block");
  await expect(blocks).toHaveCount(2);
  await expect(page.locator(".message-markdown p code")).toHaveText("code");

  const copy = blocks.first().getByRole("button", { name: "Copy code" });
  await copy.focus();
  await page.keyboard.press("Enter");
  await expect(blocks.first().getByRole("status")).toHaveText("Copied!");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(firstCode);
  await expect(blocks.last().getByRole("status")).toBeEmpty();

  await blocks.last().getByRole("button", { name: "Copy code" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("second block\n");
  await expect(blocks.last().getByRole("status")).toHaveText("Copied!");
  await expect(blocks.last().getByRole("status")).toBeEmpty({ timeout: 4_000 });
});

test("supports the plain HTTP clipboard fallback and restores focus", async ({ page }) => {
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    document.execCommand = (command) => {
      const textarea = document.activeElement as HTMLTextAreaElement;
      document.body.dataset.copiedText = textarea.value;
      return command === "copy" && textarea.tagName === "TEXTAREA";
    };
  });
  const block = page.locator(".code-block").first();
  const copy = block.getByRole("button", { name: "Copy code" });
  await copy.click();
  await expect(block.getByRole("status")).toHaveText("Copied!");
  expect(await page.evaluate(() => document.body.dataset.copiedText)).toBe(firstCode);
  await expect(copy).toBeFocused();
  await expect(page.locator("body > textarea")).toHaveCount(0);
});

test("reports clipboard failures without claiming success and allows retry", async ({ page }) => {
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("Permission denied")) },
    });
    document.execCommand = () => false;
  });
  const block = page.locator(".code-block").first();
  await block.getByRole("button", { name: "Copy code" }).click();
  await expect(block.getByRole("status")).toHaveText("Copy failed. Select and copy manually.");
  await expect(page.locator("body > textarea")).toHaveCount(0);

  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.resolve() },
    });
  });
  await block.getByRole("button", { name: "Copy code" }).click();
  await expect(block.getByRole("status")).toHaveText("Copied!");
});
