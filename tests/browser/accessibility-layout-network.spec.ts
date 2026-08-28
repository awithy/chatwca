import { networkInterfaces } from "node:os";

import { expect, test } from "@playwright/test";

import {
  createConversation,
  deleteSelectedConversation,
  waitForConnected,
} from "./helpers.js";

const port = Number(process.env.CHATWCA_BROWSER_TEST_PORT ?? 28787);

function lanAddress(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  throw new Error("A non-loopback IPv4 address is required for the LAN browser test");
}

test("keyboard focus and primary chat controls remain operable", async ({ page }) => {
  await waitForConnected(page);
  const addButton = page.getByRole("button", { name: "Add", exact: true });
  await addButton.focus();
  await page.keyboard.press("Enter");
  const name = page.getByLabel("Name");
  await expect(name).toBeFocused();
  await name.fill("Keyboard workspace");
  await page.keyboard.press("Tab");
  const path = page.getByLabel("Directory path");
  await expect(path).toBeFocused();
  await path.fill("/tmp/chatwca-browser-keyboard");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Store sessions in this workspace")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(addButton).toBeFocused();

  await createConversation(page);
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect(composer).toBeEnabled();
  await composer.focus();
  await composer.fill("Stream slowly for keyboard controls");
  await page.keyboard.press("Shift+Enter");
  await expect(page.locator(".message-user")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Attach images" })).toBeEnabled();
  await expect(page.locator(".composer")).toHaveCSS("border-color", "rgb(76, 120, 165)");

  await page.keyboard.press("Enter");
  await expect(page.locator(".header-status")).toContainText("Running");
  await expect(page.getByRole("button", { name: "Steer" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Follow up" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Abort" })).toBeVisible();
  await composer.fill("Queue this next keyboard prompt");
  await page.getByRole("button", { name: "Follow up" }).click();
  await expect(page.getByText("1 follow-up")).toBeVisible();
  await page.getByRole("button", { name: "Abort" }).click();
  await expect(page.locator(".header-status")).toContainText("Idle");
  await expect(page.getByRole("button", { name: "Close", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Delete", exact: true })).toBeEnabled();
  await deleteSelectedConversation(page);
});

test("responsive layout stays dark-only and exposes mobile navigation", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await waitForConnected(page);

  await expect(page.getByRole("button", { name: "Open workspaces and conversations" })).toBeVisible();
  await expect(page.locator(".conversation-sidebar")).not.toBeInViewport();
  const palette = await page.evaluate(() => ({
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
    background: getComputedStyle(document.body).backgroundColor,
    fits: document.documentElement.scrollWidth <= window.innerWidth,
  }));
  expect(palette).toEqual({
    colorScheme: "dark",
    background: "rgb(11, 15, 20)",
    fits: true,
  });

  await page.getByRole("button", { name: "Open workspaces and conversations" }).click();
  await expect(page.locator(".conversation-sidebar")).toBeInViewport();
  await expect(page.getByRole("button", { name: "Close workspaces and conversations" }).first()).toBeVisible();
  await page.getByRole("button", { name: "Close workspaces and conversations" }).first().click();
  await expect(page.locator(".conversation-sidebar")).not.toBeInViewport();
});

test("long conversation history scrolls without pushing the sidebar footer below the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await waitForConnected(page);
  await expect(page.locator(".conversation-row").first()).toBeVisible();

  const layout = await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>(".conversation-list");
    const sidebar = document.querySelector<HTMLElement>(".conversation-sidebar");
    const footer = document.querySelector<HTMLElement>(".connection-summary");
    if (list === null || sidebar === null || footer === null) {
      throw new Error("Expected the populated conversation sidebar");
    }
    const listItems = list.querySelector("ul");
    const firstRow = listItems?.querySelector("li");
    if (listItems === null || firstRow === null || firstRow === undefined) {
      throw new Error("Expected conversation history rows");
    }

    for (let index = 0; index < 60; index += 1) {
      listItems.append(firstRow.cloneNode(true));
    }

    return {
      viewportHeight: window.innerHeight,
      sidebarBottom: sidebar.getBoundingClientRect().bottom,
      footerBottom: footer.getBoundingClientRect().bottom,
      listClientHeight: list.clientHeight,
      listScrollHeight: list.scrollHeight,
    };
  });

  expect(layout.listScrollHeight).toBeGreaterThan(layout.listClientHeight);
  expect(layout.sidebarBottom).toBeLessThanOrEqual(layout.viewportHeight);
  expect(layout.footerBottom).toBeLessThanOrEqual(layout.viewportHeight);
});

test("serves HTTP and same-authority WebSockets through a non-loopback host", async ({ page }) => {
  const host = lanAddress();
  expect(host).not.toMatch(/^127\./);
  await page.goto(`http://${host}:${String(port)}/`);
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Select a workspace" })).toBeVisible();
  const health = await page.request.get(
    `http://${host}:${String(port)}/api/health`,
  );
  expect(health.ok()).toBe(true);
  await expect(health.json()).resolves.toMatchObject({ ready: true, version: "browser-fixture" });
});
