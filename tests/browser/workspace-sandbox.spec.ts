import { expect, test, type Page, type WebSocket as PlaywrightWebSocket } from "@playwright/test";

import { waitForConnected } from "./helpers.js";

const disabledManagedEgressConfig = {
  mode: "disabled",
  selectablePolicies: ["isolated"],
  policySets: [{
    id: "default",
    label: "Default",
    allowedDomainPatterns: [],
    allowedPorts: [80, 443],
  }],
  allowedDomainPatterns: [],
  deniedDomainPatterns: [],
  allowedPorts: [80, 443],
  supportedProtocols: ["http", "https-connect", "websocket", "websocket-secure", "socks5-tcp"],
  denyNonPublicAddresses: true,
  tlsInterception: false,
  disclosureWarning: "Tools may transmit workspace content to configured destinations.",
  functionalProbeSucceeded: false,
} as const;

interface SentFrame {
  readonly type?: string;
  readonly name?: string;
  readonly securityProfile?: string;
  readonly networkPolicy?: string;
  readonly networkPolicySetId?: string;
  readonly acknowledgeSecurityDowngrade?: boolean;
  readonly acknowledgeNetworkExposure?: boolean;
}

function captureSent(page: Page): SentFrame[] {
  const sent: SentFrame[] = [];
  page.on("websocket", (socket: PlaywrightWebSocket) => {
    socket.on("framesent", ({ payload }) => {
      if (typeof payload === "string") sent.push(JSON.parse(payload) as SentFrame);
    });
  });
  return sent;
}

async function openCreate(page: Page, name: string, directoryPath: string): Promise<void> {
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Directory path").fill(directoryPath);
}

async function addSandboxWorkspace(page: Page, name: string, directoryPath: string): Promise<void> {
  await openCreate(page, name, directoryPath);
  await page.getByRole("form", { name: "Create workspace" })
    .getByLabel("Security profile", { exact: true })
    .selectOption("workspace-sandboxed");
  await page.getByRole("button", { name: "Add workspace", exact: true }).click();
  await expect(page.locator("button.workspace-select-button").filter({ hasText: name })).toBeVisible();
}

async function openWorkspaceInfo(page: Page, name: string) {
  await page.getByRole("button", { name: `Workspace actions for ${name}` }).click();
  await page.getByRole("button", { name: `Workspace info ${name}` }).click();
  return page.getByRole("region", { name: `Workspace info for ${name}` });
}

test("optional mode defaults to Unrestricted and creates a network-isolated Workspace sandbox", async ({ page }) => {
  await waitForConnected(page);
  const name = "Sandbox profile project";
  await openCreate(page, name, "/tmp/chatwca-browser-sandbox-profile");
  const form = page.getByRole("form", { name: "Create workspace" });
  await expect(form.getByLabel("Security profile", { exact: true })).toHaveValue("unrestricted");
  await form.getByLabel("Security profile", { exact: true }).selectOption("workspace-sandboxed");
  await expect(form.getByLabel("Sandbox network", { exact: true })).toHaveValue("isolated");
  await page.getByRole("button", { name: "Add workspace", exact: true }).click();

  await page.getByRole("button", { name: `New conversation in ${name}` }).click();
  const badge = page.locator(".security-badge");
  await expect(badge).toHaveText("Sandboxed · Network isolated");
  await expect(badge).toHaveAttribute("aria-label", "Conversation security: Sandboxed · Network isolated");

  const info = await openWorkspaceInfo(page, name);
  await expect(info).toContainText("Stored profile");
  await expect(info).toContainText("Effective profile");
  await expect(info).toContainText("Optional — sandboxing is not required");
  await expect(info).toContainText("Stored network type");
  await expect(info).toContainText("Effective network type");
  await expect(info).toContainText("Stored destination policy");
  await expect(info).toContainText("Effective destination policy");
  await expect(info).toContainText("No network policy issue");
  await expect(info).toContainText("Available — startup functional probe passed");
  await expect(info).toContainText("registry.npmjs.org");
  await expect(info).toContainText("blocked.example.com");
  await expect(info).toContainText("443");
  await expect(info).toContainText("http, https-connect, websocket, websocket-secure, socks5-tcp");
  await expect(info).toContainText("loopback, LAN, link-local, metadata");
  await expect(info).toContainText("UDP and inbound connections");
  await expect(info).toContainText("outbound TCP");
  await expect(info).toContainText("HTTPS remains end-to-end encrypted");
  await expect(info).toContainText("Tools may transmit workspace content");
  await expect(info).toContainText(".git");
  await expect(info).toContainText("/usr");
  await expect(info).toContainText("administrator-approved runtime mounts");
  await expect(info).toContainText("Workspace content may still be sent to the configured model provider");
  await expect(info).toContainText("does not isolate CPU, memory, or disk denial-of-service");
  await expect(info).not.toContainText("/administrator/private/mount");
  await info.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: `Workspace actions for ${name}` }).click();
  await page.getByRole("button", { name: `Edit workspace ${name}` }).click();
  const editForm = page.getByRole("form", { name: "Edit workspace" });
  await expect(editForm.getByLabel("Directory path")).toBeDisabled();
  await expect(editForm.getByLabel("Security profile", { exact: true })).toBeDisabled();
  await expect(editForm.getByLabel("Sandbox network", { exact: true })).toBeDisabled();
});

test("managed egress creation and isolated-to-managed updates require confirmation", async ({ page }) => {
  const sent = captureSent(page);
  await waitForConnected(page);
  const name = "Managed network project";
  await openCreate(page, name, "/tmp/chatwca-browser-managed-network");
  const createForm = page.getByRole("form", { name: "Create workspace" });
  await createForm.getByLabel("Security profile", { exact: true }).selectOption("workspace-sandboxed");
  await createForm.getByLabel("Sandbox network", { exact: true }).selectOption("managed-egress");
  await expect(createForm.getByLabel("Destination policy", { exact: true })).toHaveValue("default");
  await createForm.getByLabel("Destination policy", { exact: true }).selectOption("web");
  await expect(createForm).toContainText("**.example.com");

  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Add workspace", exact: true }).click();
  await expect(createForm).toBeVisible();
  expect(sent.filter((frame) => frame.type === "workspace.create" && frame.name === name)).toHaveLength(0);

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Add workspace", exact: true }).click();
  await expect(createForm).toHaveCount(0);
  expect(sent.find((frame) => frame.type === "workspace.create" && frame.name === name)).toMatchObject({
    securityProfile: "workspace-sandboxed",
    networkPolicy: "managed-egress",
    networkPolicySetId: "web",
  });

  const isolatedName = "Network update project";
  await addSandboxWorkspace(page, isolatedName, "/tmp/chatwca-browser-network-update");
  await page.getByRole("button", { name: `Workspace actions for ${isolatedName}` }).click();
  await page.getByRole("button", { name: `Edit workspace ${isolatedName}` }).click();
  const editForm = page.getByRole("form", { name: "Edit workspace" });
  await editForm.getByLabel("Sandbox network", { exact: true }).selectOption("managed-egress");
  page.once("dialog", (dialog) => dialog.accept());
  await editForm.getByRole("button", { name: "Save changes" }).click();
  await expect(editForm).toHaveCount(0);
  expect(sent.find((frame) => frame.type === "workspace.update" && frame.name === isolatedName)).toMatchObject({
    networkPolicy: "managed-egress",
    acknowledgeNetworkExposure: true,
  });
});

test("downgrade requires confirmation and acknowledges only an accepted warning", async ({ page }) => {
  const sent = captureSent(page);
  await waitForConnected(page);
  const name = "Downgrade confirmation project";
  await addSandboxWorkspace(page, name, "/tmp/chatwca-browser-downgrade");

  await page.getByRole("button", { name: `Workspace actions for ${name}` }).click();
  await page.getByRole("button", { name: `Edit workspace ${name}` }).click();
  await page.getByRole("form", { name: "Edit workspace" })
    .getByLabel("Security profile", { exact: true })
    .selectOption("unrestricted");

  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("form", { name: "Edit workspace" })).toBeVisible();
  expect(sent.filter((frame) => frame.type === "workspace.update" && frame.name === name)).toHaveLength(0);

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("form", { name: "Edit workspace" })).toHaveCount(0);
  await expect.poll(() => sent.filter(
    (frame) => frame.type === "workspace.update" && frame.name === name,
  )).toHaveLength(1);
  expect(sent.find(
    (frame) => frame.type === "workspace.update" && frame.name === name,
  )).toMatchObject({
    securityProfile: "unrestricted",
    acknowledgeSecurityDowngrade: true,
  });
});

test("policy-blocked workspace retains history/info but disables runtime actions", async ({ page }) => {
  await waitForConnected(page);
  const name = "Policy blocked project";
  await openCreate(page, name, "/tmp/chatwca-fixture-policy-blocked");
  await page.getByRole("button", { name: "Add workspace", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Workspace blocked by policy" })).toBeVisible();
  await expect(page.getByText("Policy blocked", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: `New conversation in ${name}` })).toBeDisabled();
  await expect(page.getByText("New, Open, Fork, and Rewind are disabled.")).toBeVisible();

  const info = await openWorkspaceInfo(page, name);
  await expect(info).toContainText("Policy blocked — Directory is outside administrator-approved workspace roots.");
  await expect(info).toContainText("Session path");
});

test("invalid public configuration fails conservatively without profile controls", async ({ page }) => {
  await page.route("**/api/config", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ maxImages: 4 }),
  }));
  await page.goto("/");
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add", exact: true })).toBeDisabled();
  await expect(page.getByRole("form", { name: "Create workspace" })).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("invalid public configuration");
});

test("required authoritative mode fixes creation to Workspace sandbox", async ({ page }) => {
  const sent = captureSent(page);
  await page.route("**/api/config", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      maxImages: 4,
      maxImageBytes: 2 * 1024 * 1024,
      maxTotalImageBytes: 4 * 1024 * 1024,
      sandbox: {
        mode: "required",
        selectableProfiles: ["workspace-sandboxed"],
        remoteProviderWarning: "Workspace content may still be sent to the configured model provider.",
        functionalProbeSucceeded: true,
      },
      managedEgress: disabledManagedEgressConfig,
    }),
  }));
  await waitForConnected(page);
  await openCreate(page, "Required mode project", "/tmp/chatwca-browser-required-mode");
  await expect(page.getByText("The server requires Workspace sandbox for every runtime.")).toBeVisible();
  const form = page.getByRole("form", { name: "Create workspace" });
  await expect(form.locator("select")).toHaveCount(0);
  await expect(form.getByLabel("Security profile", { exact: true })).toHaveText("Workspace sandbox");
  await expect(form.getByLabel("Sandbox network", { exact: true })).toHaveText("Isolated");
  await page.getByRole("button", { name: "Add workspace", exact: true }).click();
  await expect.poll(() => sent.some(
    (frame) => frame.type === "workspace.create" &&
      frame.name === "Required mode project" &&
      frame.securityProfile === "workspace-sandboxed",
  )).toBe(true);
});

test("disabled authoritative mode fixes creation to Unrestricted", async ({ page }) => {
  const sent = captureSent(page);
  await page.route("**/api/config", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      maxImages: 4,
      maxImageBytes: 2 * 1024 * 1024,
      maxTotalImageBytes: 4 * 1024 * 1024,
      sandbox: {
        mode: "disabled",
        selectableProfiles: ["unrestricted"],
        remoteProviderWarning: "Workspace content may still be sent to the configured model provider.",
        functionalProbeSucceeded: false,
      },
      managedEgress: disabledManagedEgressConfig,
    }),
  }));
  await waitForConnected(page);
  await openCreate(page, "Disabled mode project", "/tmp/chatwca-browser-disabled-mode");
  const form = page.getByRole("form", { name: "Create workspace" });
  await expect(form.getByLabel("Security profile", { exact: true })).toHaveText("Unrestricted");
  await expect(form.getByLabel("Sandbox network", { exact: true })).toHaveCount(0);
  await expect(form.locator("select")).toHaveCount(0);
  await page.getByRole("button", { name: "Add workspace", exact: true }).click();
  await expect.poll(() => sent.some(
    (frame) => frame.type === "workspace.create" &&
      frame.name === "Disabled mode project" &&
      frame.securityProfile === "unrestricted",
  )).toBe(true);
});
