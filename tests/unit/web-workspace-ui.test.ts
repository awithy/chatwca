import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  PublicManagedEgressConfig,
  PublicSandboxConfig,
  WorkspaceSummary,
} from "../../src/shared/protocol.js";
import { WorkspaceForm } from "../../src/web/src/components/WorkspaceForm.js";
import {
  WorkspaceSidebar,
  networkPolicyIssueLabel,
  workspaceUpdatePlan,
  securityDowngradeConfirmation,
  sortWorkspacesByMostRecentlyUsed,
  workspacePolicyIssueLabel,
  workspaceRemovalConfirmation,
} from "../../src/web/src/components/WorkspaceSidebar.js";

const optionalConfig: PublicSandboxConfig = {
  mode: "optional",
  selectableProfiles: ["unrestricted", "workspace-sandboxed"],
  remoteProviderWarning: "Workspace content may still be sent to the configured model provider.",
  functionalProbeSucceeded: true,
};

const managedConfig: PublicManagedEgressConfig = {
  mode: "optional",
  selectablePolicies: ["isolated", "managed-egress"],
  policySets: [
    { id: "default", label: "Package registries", allowedDomainPatterns: ["registry.npmjs.org"], allowedPorts: [443] },
    { id: "web", label: "Example web", allowedDomainPatterns: ["**.example.com"], allowedPorts: [80, 443] },
  ],
  allowedDomainPatterns: ["**.example.com"],
  deniedDomainPatterns: ["blocked.example.com"],
  allowedPorts: [80, 443],
  supportedProtocols: ["http", "https-connect", "websocket", "websocket-secure", "socks5-tcp"],
  denyNonPublicAddresses: true,
  tlsInterception: false,
  disclosureWarning: "Tools may transmit workspace content to configured destinations.",
  functionalProbeSucceeded: true,
};

const workspace: WorkspaceSummary = {
  id: "workspace-1",
  name: "Deep Project",
  path: "/srv/projects/a/very/long/full/path/to/deep-project",
  sessionStorage: "pi-default",
  sessionDirectory: null,
  securityProfile: "unrestricted",
  mounts: [],
  networkPolicy: "isolated",
  effectiveSecurityProfile: "unrestricted",
  effectiveNetworkPolicy: null,
  networkPolicySetId: "default",
  effectiveNetworkPolicySetId: null,
  networkPolicyIssue: null,
  createdAt: 1,
  updatedAt: 2,
  available: true,
  usable: true,
  policyIssue: null,
};

function sidebar(workspaces: readonly WorkspaceSummary[], selectedWorkspaceId: string | null): string {
  return renderToStaticMarkup(createElement(WorkspaceSidebar, {
    workspaces,
    selectedWorkspaceId,
    conversations: [],
    liveStatuses: {},
    liveWorkspaceIds: new Set<string>(),
    selectedConversationId: null,
    connected: true,
    historyPending: false,
    historyError: null,
    actionPending: false,
    publicSandboxConfig: optionalConfig,
    publicManagedEgressConfig: managedConfig,
    open: false,
    onDismiss: () => undefined,
    onOpenJobs: () => undefined,
    onSelectWorkspace: () => undefined,
    onCreateWorkspace: async () => undefined,
    onUpdateWorkspace: async () => undefined,
    onRemoveWorkspace: async () => undefined,
    onCreateConversation: async () => undefined,
    onSelectConversation: () => undefined,
  }));
}

function renderForm(
  publicSandboxConfig: PublicSandboxConfig,
  overrides: Partial<Parameters<typeof WorkspaceForm>[0]> = {},
): string {
  return renderToStaticMarkup(createElement(WorkspaceForm, {
    mode: "create",
    publicSandboxConfig,
    publicManagedEgressConfig: managedConfig,
    securityControlsLocked: false,
    submitting: false,
    error: null,
    onSubmit: async () => undefined,
    onCancel: () => undefined,
    ...overrides,
  }));
}

describe("workspace-first sidebar", () => {
  it("uses workspace-first ARIA, full paths, and labeled management actions without a healthy-status badge", () => {
    const html = sidebar([workspace], workspace.id);

    expect(html).toContain('aria-label="Workspaces and conversations"');
    expect(html).toContain(workspace.path);
    expect(html).toContain('aria-label="Workspace actions for Deep Project"');
    expect(html).toContain('aria-label="Workspace info Deep Project"');
    expect(html).toContain('aria-label="Edit workspace Deep Project"');
    expect(html).toContain('aria-label="Remove workspace Deep Project"');
    expect(html).toContain('aria-current="true"');
    expect(html).not.toContain('class="workspace-usable"');
    expect(html).not.toContain(">Usable<");
  });

  it("onboards without selecting or loading conversation history", () => {
    const empty = sidebar([], null);
    expect(empty).toContain("Add your first workspace");
    expect(empty).toContain("Select a workspace to load its conversations.");
  });

  it("marks unavailable workspaces and prevents new conversations", () => {
    const html = sidebar([{ ...workspace, available: false, usable: false }], workspace.id);
    expect(html).toContain("Unavailable");
    expect(html).toContain("Workspace unavailable");
    expect(html).toMatch(/<button class="new-conversation-button"[^>]*disabled=""/);
  });

  it("distinguishes policy blocks with redacted, actionable reasons", () => {
    const blocked = {
      ...workspace,
      usable: false,
      effectiveSecurityProfile: null,
      policyIssue: "outside_workspace_roots" as const,
    };
    const html = sidebar([blocked], blocked.id);

    expect(html).toContain("Policy blocked");
    expect(html).toContain("Workspace blocked by policy");
    expect(html).toContain("New, Open, Fork, and Rewind are disabled");
    expect(workspacePolicyIssueLabel(blocked.policyIssue)).toContain("administrator-approved workspace roots");
    expect(networkPolicyIssueLabel("managed_egress_disabled")).toContain("disabled by the administrator");
  });

  it("sorts workspaces by most recent use without disturbing unseen order", () => {
    const workspaces = [
      { ...workspace, id: "workspace-a", name: "A" },
      { ...workspace, id: "workspace-b", name: "B" },
      { ...workspace, id: "workspace-c", name: "C" },
    ];
    expect(sortWorkspacesByMostRecentlyUsed(workspaces, ["workspace-c", "workspace-a"])
      .map(({ id }) => id)).toEqual(["workspace-c", "workspace-a", "workspace-b"]);
    expect(workspaces.map(({ id }) => id)).toEqual(["workspace-a", "workspace-b", "workspace-c"]);
  });

  it("states retention and downgrade consequences explicitly", () => {
    expect(workspaceRemovalConfirmation(workspace)).toContain("will not be deleted");
    const warning = securityDowngradeConfirmation({
      ...workspace,
      securityProfile: "workspace-sandboxed",
      effectiveSecurityProfile: "workspace-sandboxed",
    });
    expect(warning).toContain("Workspace sandbox to Unrestricted");
    expect(warning).toContain("reduces protection");
  });
});

describe("workspace form", () => {
  it("renders accessible optional-mode controls defaulted to unrestricted", () => {
    const html = renderForm(optionalConfig, {
      error: "That workspace path is already registered.",
    });

    expect(html).toContain('aria-label="Create workspace"');
    expect(html).toContain("Directory path");
    expect(html).toContain("Security profile");
    expect(html).toContain("Workspace sandbox");
    expect(html).toContain('value="unrestricted" selected=""');
    expect(html).toContain("Store sessions in this workspace");
    expect(html).toContain('role="alert"');
  });

  it("shows stored/effective values and locks path/profile while live", () => {
    const html = renderForm(optionalConfig, {
      mode: "edit",
      initialValues: {
        name: workspace.name,
        path: workspace.path,
        sessionStorage: workspace.sessionStorage,
        securityProfile: "unrestricted",
        networkPolicy: "isolated",
        networkPolicySetId: "default",
        effectiveSecurityProfile: "workspace-sandboxed",
        effectiveNetworkPolicy: "isolated",
        effectiveNetworkPolicySetId: null,
        networkPolicyIssue: null,
      },
      securityControlsLocked: true,
      submitting: true,
    });

    expect(html).toContain('aria-label="Edit workspace"');
    expect(html).toContain("Stored profile");
    expect(html).toContain("Effective profile");
    expect(html).toContain("Stored network type");
    expect(html).toContain("Effective network type");
    expect(html).toContain("Stored destination policy");
    expect(html).toContain("Effective destination policy");
    expect(html).toContain("Network policy issue");
    expect(html).toContain("Sandbox network");
    expect(html).toContain("Close this workspace’s live conversations");
    expect(html).toContain("Workspace sandbox");
    expect(html).not.toContain("Store sessions in this workspace");
  });

  it("shows stored managed policy and its separate issue while offering only server-selectable recovery", () => {
    const html = renderForm(optionalConfig, {
      mode: "edit",
      initialValues: {
        name: workspace.name,
        path: workspace.path,
        sessionStorage: workspace.sessionStorage,
        securityProfile: "workspace-sandboxed",
        networkPolicy: "managed-egress",
        networkPolicySetId: "retired",
        effectiveSecurityProfile: "workspace-sandboxed",
        effectiveNetworkPolicy: null,
        effectiveNetworkPolicySetId: null,
        networkPolicyIssue: "managed_egress_policy_set_unavailable",
      },
      publicManagedEgressConfig: {
        ...managedConfig,
        mode: "disabled",
        selectablePolicies: ["isolated"],
        allowedDomainPatterns: [],
        functionalProbeSucceeded: false,
      },
    });

    expect(html).toContain("Managed egress — unavailable");
    expect(html).toContain("retired — unavailable");
    expect(html).toContain("stored destination policy is no longer available");
    expect(html).toContain('<option value="isolated">Isolated</option>');
    expect(html).not.toContain('<option value="managed-egress">Managed egress</option>');
  });

  it("shows only named destination sets and read-only normalized disclosures for managed egress", () => {
    const html = renderForm(optionalConfig, {
      mode: "edit",
      initialValues: {
        name: workspace.name,
        path: workspace.path,
        sessionStorage: workspace.sessionStorage,
        securityProfile: "workspace-sandboxed",
        networkPolicy: "managed-egress",
        networkPolicySetId: "web",
        effectiveSecurityProfile: "workspace-sandboxed",
        effectiveNetworkPolicy: "managed-egress",
        effectiveNetworkPolicySetId: "web",
        networkPolicyIssue: null,
      },
    });

    expect(html).toContain("Destination policy");
    expect(html).toContain("Package registries (default)");
    expect(html).toContain("Example web (web)");
    expect(html).toContain("**.example.com");
    expect(html).toContain("80, 443");
    expect(html).not.toContain('name="allowedDomains"');
    expect(html).not.toContain('name="allowedPorts"');
  });

  it("builds exact set-change and acknowledgement updates without destination rules", () => {
    const managed = {
      ...workspace,
      securityProfile: "workspace-sandboxed" as const,
      networkPolicy: "managed-egress" as const,
      effectiveSecurityProfile: "workspace-sandboxed" as const,
      effectiveNetworkPolicy: "managed-egress" as const,
      effectiveNetworkPolicySetId: "default",
    };
    const plan = workspaceUpdatePlan(managed, {
      name: managed.name,
      path: managed.path,
      sessionStorage: managed.sessionStorage,
      securityProfile: "workspace-sandboxed",
      mounts: [],
      networkPolicy: "managed-egress",
      networkPolicySetId: "web",
    });

    expect(plan.addsNetworkExposure).toBe(true);
    expect(plan.changes).toEqual({
      name: managed.name,
      networkPolicySetId: "web",
      acknowledgeNetworkExposure: true,
    });
    expect(plan.changes).not.toHaveProperty("allowedDomains");
    expect(plan.changes).not.toHaveProperty("allowedPorts");
  });

  it("plans mount updates and acknowledges newly writable host directories", () => {
    const sandboxed = {
      ...workspace,
      securityProfile: "workspace-sandboxed" as const,
      effectiveSecurityProfile: "workspace-sandboxed" as const,
      effectiveNetworkPolicy: "isolated" as const,
      mounts: [{ name: "shared", source: "/srv/shared", access: "read-only" as const }],
    };
    const plan = workspaceUpdatePlan(sandboxed, {
      name: sandboxed.name,
      path: sandboxed.path,
      sessionStorage: sandboxed.sessionStorage,
      securityProfile: sandboxed.securityProfile,
      mounts: [{ name: "shared", source: "/srv/shared", access: "read-write" }],
      networkPolicy: sandboxed.networkPolicy,
      networkPolicySetId: sandboxed.networkPolicySetId,
    });

    expect(plan.addsWritableMounts).toBe(true);
    expect(plan.changes).toMatchObject({
      mounts: [{ name: "shared", source: "/srv/shared", access: "read-write" }],
      acknowledgeWritableMounts: true,
    });
  });

  it("implements disabled, optional, and required profile semantics", () => {
    const disabled = renderForm({
      ...optionalConfig,
      mode: "disabled",
      selectableProfiles: ["unrestricted"],
      functionalProbeSucceeded: false,
    });
    expect(disabled).toContain("Unrestricted");
    expect(disabled).not.toContain("<select");

    const required = renderForm({
      ...optionalConfig,
      mode: "required",
      selectableProfiles: ["workspace-sandboxed"],
    });
    expect(required).toContain("Workspace sandbox");
    expect(required).toContain("server requires Workspace sandbox");
    expect(required).toContain("Sandbox network");
    expect(required).toContain("Managed egress");
    expect(required.match(/<select/g)).toHaveLength(1);
  });
});
