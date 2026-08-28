import { expect, test } from "@playwright/test";

import {
  createConversation,
  deleteSelectedConversation,
  submitAndWait,
  waitForConnected,
} from "./helpers.js";

test("fork selects a new conversation and prefills an editable unsent prompt", async ({ page }) => {
  const sourcePrompt = "Fork this editable prompt";
  await waitForConnected(page);
  await createConversation(page);
  await submitAndWait(page, sourcePrompt);

  const sourceRow = page.locator("button.conversation-row").filter({
    has: page.getByText(sourcePrompt, { exact: true }),
  });
  const sourceMessages = await page.locator(".chat-message").count();
  await page.getByRole("button", { name: "Fork conversation from this message" }).click();

  const composer = page.getByRole("textbox", { name: "Message" });
  await expect(page.getByRole("heading", { name: `Fork of ${sourcePrompt}` })).toBeVisible();
  await expect(composer).toHaveValue(sourcePrompt);
  await expect(page.locator(".chat-message")).toHaveCount(0);
  await composer.fill(`${sourcePrompt} with browser edits`);
  await expect(composer).toHaveValue(`${sourcePrompt} with browser edits`);
  await expect(page.locator(".message-user")).toHaveCount(0);
  await expect(sourceRow).toBeVisible();

  await deleteSelectedConversation(page);
  await sourceRow.click();
  await expect(page.locator(".chat-message")).toHaveCount(sourceMessages);
  await deleteSelectedConversation(page);
});

test("recovers only the in-memory selected workspace and conversation after a socket interruption", async ({ page }) => {
  const sent: Array<{
    socket: number;
    type?: string;
    workspaceId?: string;
    conversationId?: string;
  }> = [];
  let socketSequence = 0;
  page.on("websocket", (socket) => {
    socketSequence += 1;
    const socketId = socketSequence;
    socket.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") return;
      sent.push({ socket: socketId, ...(JSON.parse(payload) as object) });
    });
  });

  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    class CountingWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        const counters = window as typeof window & {
          __chatwcaSocketOpens?: number;
          __chatwcaSocketCloses?: number;
        };
        counters.__chatwcaSocketOpens = (counters.__chatwcaSocketOpens ?? 0) + 1;
        this.addEventListener("close", () => {
          counters.__chatwcaSocketCloses = (counters.__chatwcaSocketCloses ?? 0) + 1;
        });
      }
    }
    window.WebSocket = CountingWebSocket;
  });

  const prompt = "Reconnect while streaming";
  await waitForConnected(page);
  await createConversation(page);
  await page.getByRole("textbox", { name: "Message" }).fill(prompt);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator(".header-status")).toContainText("Running");

  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __chatwcaSocketCloses?: number }
  ).__chatwcaSocketCloses ?? 0)).toBeGreaterThanOrEqual(1);
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { __chatwcaSocketOpens?: number }
  ).__chatwcaSocketOpens ?? 0)).toBeGreaterThanOrEqual(2);
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect(page.locator(".message-assistant").last()).toContainText(
    `Deterministic response to: ${prompt}`,
    { timeout: 4_000 },
  );
  await expect(page.locator(".header-status")).toContainText("Idle");
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("");

  const initiallySelectedWorkspace = sent.find(
    ({ socket, type }) => socket === 1 && type === "history.list",
  )?.workspaceId;
  const reconnectSocket = Math.max(...sent.map(({ socket }) => socket));
  const reconnectCommands = sent.filter(({ socket }) => socket === reconnectSocket);
  expect(reconnectCommands[0]?.type).toBe("workspace.list");
  expect(reconnectCommands.filter(({ type }) => type === "history.list")).toEqual([
    expect.objectContaining({ workspaceId: initiallySelectedWorkspace }),
  ]);
  expect(reconnectCommands.filter(({ type }) => type === "conversation.state")).toEqual([
    expect.objectContaining({ conversationId: expect.stringMatching(/^browser-created-/) }),
  ]);

  await deleteSelectedConversation(page);
});
