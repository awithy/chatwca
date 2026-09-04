import { networkInterfaces } from "node:os";

import { expect, test } from "@playwright/test";

import {
  createConversation,
  deleteSelectedConversation,
  submitAndWait,
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
  await expect(page.getByLabel("Security profile", { exact: true })).toBeFocused();
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

test("responsive layout prioritizes chat and moves navigation and actions into mobile menus", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await waitForConnected(page);

  await expect(page.getByRole("button", { name: "Open workspaces and conversations" })).toBeVisible();
  await expect(page.locator(".conversation-sidebar")).not.toBeInViewport();
  await expect(page.getByRole("navigation", { name: "Application sections", exact: true })).toBeHidden();
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
  const mobileSections = page.getByRole("navigation", { name: "Mobile application sections" });
  await expect(mobileSections.getByRole("button", { name: "Conversations" })).toHaveAttribute("aria-current", "page");
  await mobileSections.getByRole("button", { name: "Jobs" }).click();
  await expect(page.getByRole("heading", { name: "Scheduled jobs" })).toBeVisible();
  await page.getByRole("button", { name: "Open application navigation" }).click();
  await page.getByRole("navigation", { name: "Mobile application sections" }).getByRole("button", { name: "Conversations" }).click();
  await expect(page.getByRole("heading", { name: "Start in Browser workspace" })).toBeVisible();
  await expect(page.locator(".conversation-sidebar")).not.toBeInViewport();

  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await expect(page.locator(".conversation-header")).toBeHidden();
  await expect(page.getByRole("button", { name: "Open conversation actions" })).toBeVisible();
  const layout = await page.evaluate(() => ({
    contentHeight: document.querySelector<HTMLElement>(".conversation-content")?.getBoundingClientRect().height ?? 0,
    timelineHeight: document.querySelector<HTMLElement>(".message-timeline")?.getBoundingClientRect().height ?? 0,
  }));
  expect(layout.contentHeight).toBeGreaterThan(750);
  expect(layout.timelineHeight).toBeGreaterThan(600);

  await page.getByRole("button", { name: "Open conversation actions" }).click();
  const actions = page.getByRole("region", { name: "Conversation actions" });
  await expect(actions.getByRole("button", { name: "New conversation" })).toBeVisible();
  await expect(actions.getByRole("button", { name: "Rename" })).toBeVisible();
  await expect(actions.getByRole("button", { name: "Close", exact: true })).toBeEnabled();
  await expect(actions.getByRole("button", { name: "Delete", exact: true })).toBeEnabled();
  await actions.getByRole("button", { name: "Rename" }).click();
  await page.getByLabel("Conversation title", { exact: true }).fill("Mobile conversation");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.locator(".mobile-app-title strong")).toHaveText("Mobile conversation");

  await page.getByRole("button", { name: "Open conversation actions" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("region", { name: "Conversation actions" }).getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Start in Browser workspace" })).toBeVisible();
});

test("long generated conversation titles do not push the chat workspace out of view", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 720 });
  await waitForConnected(page);
  await createConversation(page);

  const prompt = [
    "Explain how this deliberately long initial prompt becomes a conversation title",
    "while the message timeline and composer remain inside the visible chat workspace",
    "instead of being pushed beyond the right edge of a laptop-sized viewport.",
  ].join(" ");
  await submitAndWait(page, prompt);
  await expect(page.getByRole("heading", { name: prompt })).toBeVisible();

  const layout = await page.evaluate(() => {
    const conversationPage = document.querySelector<HTMLElement>(".conversation-page");
    const header = document.querySelector<HTMLElement>(".conversation-header");
    const content = document.querySelector<HTMLElement>(".conversation-content");
    const composer = document.querySelector<HTMLElement>(".composer");
    const title = document.querySelector<HTMLElement>(".conversation-title-row h1");
    if (
      conversationPage === null || header === null || content === null ||
      composer === null || title === null
    ) {
      throw new Error("Expected an open conversation layout");
    }

    return {
      page: conversationPage.getBoundingClientRect().toJSON(),
      header: header.getBoundingClientRect().toJSON(),
      content: content.getBoundingClientRect().toJSON(),
      composer: composer.getBoundingClientRect().toJSON(),
      titleIsTruncated: title.scrollWidth > title.clientWidth,
    };
  });

  expect(layout.header.right).toBeLessThanOrEqual(layout.page.right);
  expect(layout.content.right).toBeLessThanOrEqual(layout.page.right);
  expect(layout.composer.left).toBeGreaterThanOrEqual(layout.page.left);
  expect(layout.composer.right).toBeLessThanOrEqual(layout.page.right);
  expect(layout.titleIsTruncated).toBe(true);
  await deleteSelectedConversation(page);
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
