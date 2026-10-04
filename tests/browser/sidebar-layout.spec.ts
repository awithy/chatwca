import { expect, test } from "@playwright/test";
import { waitForConnected } from "./helpers.js";

for (const width of [1280, 390]) {
  test(`compact sidebar gives conversation history the remaining space and scrolls both lists (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 720 });
    await waitForConnected(page);
    if (width === 390) {
      await page.getByRole("button", { name: "Open workspaces and conversations" }).click();
    }
    const sidebar = page.locator(".conversation-sidebar");
    await expect(sidebar).toBeInViewport();
    await expect(page.locator(".conversation-row").first()).toBeVisible();
    expect((await sidebar.boundingBox())?.width).toBeLessThanOrEqual(274);
    expect((await sidebar.locator(".sidebar-brand").boundingBox())?.height).toBeLessThanOrEqual(34);
    expect((await sidebar.locator(".connection-summary").boundingBox())?.height).toBeLessThanOrEqual(30);
    const workspaceCount = await sidebar.locator(".workspace-item").count();
    expect((await sidebar.locator(".workspace-panel").boundingBox())?.height).toBeLessThanOrEqual(
      Math.min(720 * 0.35, 44 + workspaceCount * 44),
    );
    expect((await sidebar.locator(".conversation-list-panel").boundingBox())?.height).toBeGreaterThan(320);
    expect((await sidebar.locator(".workspace-item").first().boundingBox())?.height).toBeLessThanOrEqual(42);
    expect((await sidebar.locator(".conversation-row:not(:has(.scheduled-job-label, .unavailable-label))").first().boundingBox())?.height).toBeLessThanOrEqual(44);
    for (const button of [
      sidebar.getByRole("button", { name: "Add", exact: true }),
      sidebar.getByRole("button", { name: "New conversation in Browser workspace" }),
      sidebar.getByRole("button", { name: "Workspace actions for Browser workspace" }),
    ]) {
      expect((await button.boundingBox())?.height).toBeLessThanOrEqual(26);
    }

    // Populate enough rows to exercise independently bounded scrolling, even on a short screen.
    await page.evaluate(() => {
      for (const selector of [".workspace-list", ".conversation-list > ul"]) {
        const list = document.querySelector(selector);
        const row = list?.firstElementChild;
        if (!list || !row) throw new Error("Expected populated sidebar lists");
        for (let i = 0; i < 40; i++) list.append(row.cloneNode(true));
      }
    });
    await page.setViewportSize({ width, height: 480 });
    for (const selector of [".workspace-panel", ".conversation-list"]) {
      const list = sidebar.locator(selector);
      expect(await list.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
      await list.evaluate(el => { el.scrollTop = el.scrollHeight; });
      expect(await list.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    }
    await expect(sidebar.locator(".connection-summary")).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("long workspace names and paths stay compact with full values available as tooltips", async ({ page }) => {
  await waitForConnected(page);
  const name = "A deliberately long workspace name for the compact sidebar layout";
  const path = `/tmp/chatwca-browser-sidebar/${"long-directory-name/".repeat(8)}project`;
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const form = page.getByRole("form", { name: "Create workspace" });
  await form.getByLabel("Name", { exact: true }).fill(name);
  await form.getByLabel("Directory path").fill(path);
  await form.getByRole("button", { name: "Add workspace", exact: true }).click();
  const row = page.locator(".workspace-select-button").filter({ hasText: name });
  await expect(row).toBeVisible();
  await expect(row.locator("strong")).toHaveAttribute("title", name);
  await expect(row.locator("code")).toHaveAttribute("title", path);
  expect((await row.boundingBox())?.height).toBeLessThanOrEqual(42);
  for (const selector of ["strong", "code"]) {
    expect(await row.locator(selector).evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  }
  await page.getByRole("button", { name: `Workspace actions for ${name}` }).click();
  await page.getByRole("button", { name: `Workspace info ${name}` }).click();
  const info = page.getByRole("region", { name: `Workspace info for ${name}` });
  await expect(info).toContainText(path);
  await info.getByRole("button", { name: "Close", exact: true }).click();
  await expect(info).toBeHidden();
  await page.getByRole("button", { name: `Workspace actions for ${name}` }).click();
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: `Remove workspace ${name}` }).click();
  await expect(row).toHaveCount(0);
});
