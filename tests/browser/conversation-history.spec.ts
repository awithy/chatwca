import { expect, test, type Page } from "@playwright/test";
import { openConversationActions, waitForConnected } from "./helpers.js";

const optional = process.env.CHATWCA_BROWSER_HISTORY_MODE === "optional";

function capture(page: Page): Record<string, unknown>[] {
  const sent: Record<string, unknown>[] = [];
  page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
    if (typeof payload === "string") sent.push(JSON.parse(payload) as Record<string, unknown>);
  }));
  return sent;
}
async function createForm(page: Page, name: string) {
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const form = page.getByRole("form", { name: "Create workspace" });
  await form.getByLabel("Name", { exact: true }).fill(name);
  await form.getByLabel("Directory path").fill(`/tmp/chatwca-browser-${name.replaceAll(" ", "-")}`);
  return form;
}
async function edit(page: Page, name: string) {
  const actions = page.getByRole("button", { name: `Workspace actions for ${name}` });
  if (await actions.getAttribute("aria-expanded") !== "true") await actions.click();
  await page.getByRole("button", { name: `Edit workspace ${name}` }).click();
  return page.getByRole("form", { name: "Edit workspace" });
}
async function info(page: Page, name: string) {
  await page.getByRole("button", { name: `Workspace actions for ${name}` }).click();
  await page.getByRole("button", { name: `Workspace info ${name}` }).click();
  return page.getByRole("region", { name: `Workspace info for ${name}` });
}

for (const profile of ["unrestricted", "workspace-sandboxed"] as const) {
  test(`history selection survives optional outage, locks live, and clears on reopen (${profile})`, async ({ page }) => {
    test.skip(!optional, "Requires the synthetic optional-mode outage fixture");
    const sent = capture(page);
    await waitForConnected(page);
    const name = `History ${profile}`;
    const form = await createForm(page, name);
    const selection = form.getByRole("checkbox", { name: "Enable conversation history", exact: true });
    await expect(selection).not.toBeChecked();
    await expect(selection).toBeEnabled();
    await expect(form).toContainText("cached user/assistant dialogue from all registered workspaces");
    await expect(form).toContainText("outside workspace sandboxing");
    await expect(form).toContainText("model provider; search may also use optional provider reranking");
    await expect(form).toContainText("selected tools remain granted but calls may fail");
    await form.getByLabel("Security profile", { exact: true }).selectOption(profile);
    await selection.check();
    await form.getByRole("button", { name: "Add workspace", exact: true }).click();
    await expect(page.locator(".workspace-select-button").filter({ hasText: name })).toBeVisible();
    expect(sent.find((frame) => frame.type === "workspace.create" && frame.name === name)).toMatchObject({ conversationToolsEnabled: true });

    const details = await info(page, name);
    await expect(details).toContainText("Stored conversation historyEnabled");
    await expect(details).toContainText("conversation_search");
    await expect(details).toContainText("conversation_read");
    await expect(details).toContainText("cached history unavailable");
    await details.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: `New conversation in ${name}` }).click();
    const badge = page.locator(".conversation-tools-badge");
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute("aria-label", /Captured conversation history tools: conversation_search, conversation_read/);

    const locked = await edit(page, name);
    await expect(locked.getByRole("checkbox", { name: "Enable conversation history", exact: true })).toBeDisabled();
    await expect(locked.getByRole("checkbox", { name: "Enable conversation history", exact: true })).toBeChecked();
    await locked.getByLabel("Name", { exact: true }).fill(`${name} updated`);
    await locked.getByRole("button", { name: "Save changes" }).click();
    await expect(locked).not.toBeVisible();
    const rename = sent.find((frame) => frame.type === "workspace.update" && frame.name === `${name} updated`);
    expect(rename).not.toHaveProperty("conversationToolsEnabled");
    await expect(badge).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Open conversation actions" }).click();
    const mobile = page.getByRole("region", { name: "Conversation actions" });
    await expect(mobile).toContainText("Conversation history toolsconversation_search, conversation_read");
    await expect(mobile).toContainText("all registered workspaces");
    await expect(mobile).toContainText("optional provider reranking");
    await expect(mobile.locator(".mobile-conversation-history-fact dd")).toHaveCSS("white-space", "normal");
    await page.keyboard.press("Escape");
    await expect(mobile).not.toBeVisible();
    await page.setViewportSize({ width: 1280, height: 720 });
    await openConversationActions(page);
    await page.locator(".conversation-header-actions").getByRole("button", { name: "Close", exact: true }).click();

    const idle = await edit(page, `${name} updated`);
    await idle.getByRole("checkbox", { name: "Enable conversation history", exact: true }).uncheck();
    await idle.getByRole("button", { name: "Save changes" }).click();
    await expect(idle).not.toBeVisible();
    expect(sent.filter((frame) => frame.type === "workspace.update").at(-1)).toMatchObject({ conversationToolsEnabled: false });
    await page.locator(".conversation-row").filter({ hasText: "Untitled conversation" }).first().click();
    await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
    await expect(badge).toHaveCount(0);
  });
}

test("disabled mode defaults history off and does not send an unavailable grant", async ({ page }) => {
  test.skip(optional, "Requires disabled-mode fixture");
  const sent = capture(page);
  await waitForConnected(page);
  const form = await createForm(page, "History disabled default");
  const selection = form.getByRole("checkbox", { name: "Enable conversation history", exact: true });
  await expect(selection).not.toBeChecked();
  await expect(selection).toBeDisabled();
  await expect(form).toContainText("Unavailable — search is disabled");
  await form.getByRole("button", { name: "Add workspace", exact: true }).click();
  await expect(form).not.toBeVisible();
  expect(sent.find((frame) => frame.type === "workspace.create" && frame.name === "History disabled default")).toMatchObject({ conversationToolsEnabled: false });
});

test("disabled mode preserves stored history on rename and permits idle removal", async ({ page }) => {
  test.skip(optional, "Requires disabled-mode fixture");
  const sent = capture(page);
  await waitForConnected(page);
  // Seed persisted selection through the real closed protocol, as if retained from optional mode.
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const url = new URL("/ws", location.href); url.protocol = "ws:";
      const socket = new WebSocket(url);
      const timeout = setTimeout(() => { socket.close(); reject(new Error("Seed timed out")); }, 5000);
      socket.onopen = () => socket.send(JSON.stringify({ type: "workspace.create", requestId: "seed-history",
        name: "History retained", path: "/tmp/chatwca-browser-history-retained", sessionStorage: "pi-default",
        securityProfile: "unrestricted", conversationToolsEnabled: true }));
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data as string) as { requestId?: string; type: string };
        if (message.requestId !== "seed-history") return;
        clearTimeout(timeout); socket.close();
        if (message.type === "error") reject(new Error("Seed rejected")); else resolve();
      };
    });
  });
  await page.reload();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  const details = await info(page, "History retained");
  await expect(details).toContainText("Stored conversation historyEnabled");
  await expect(details).toContainText("Effective conversation toolsNone");
  await expect(details).toContainText("stored selection is retained");
  await details.getByRole("button", { name: "Close", exact: true }).click();
  const preserved = await edit(page, "History retained");
  await expect(preserved.getByRole("checkbox", { name: "Enable conversation history", exact: true })).toBeChecked();
  await expect(preserved.getByRole("checkbox", { name: "Enable conversation history", exact: true })).toBeEnabled();
  await preserved.getByLabel("Name", { exact: true }).fill("History retained updated");
  await preserved.getByRole("button", { name: "Save changes" }).click();
  await expect(preserved).not.toBeVisible();
  expect(sent.find((frame) => frame.type === "workspace.update" && frame.name === "History retained updated")).not.toHaveProperty("conversationToolsEnabled");
  const removal = await edit(page, "History retained updated");
  const selection = removal.getByRole("checkbox", { name: "Enable conversation history", exact: true });
  await selection.uncheck();
  await expect(selection).toBeDisabled();
  await removal.getByRole("button", { name: "Save changes" }).click();
  await expect(removal).not.toBeVisible();
  expect(sent.filter((frame) => frame.type === "workspace.update").at(-1)).toMatchObject({ conversationToolsEnabled: false });
});
