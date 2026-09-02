import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type {
  ConversationSummary,
  LiveConversationStatus,
  PublicManagedEgressConfig,
  PublicSandboxConfig,
  SandboxNetworkPolicy,
  WorkspaceNetworkPolicyIssue,
  WorkspacePolicyIssue,
  WorkspaceMount,
  WorkspaceSecurityProfile,
  WorkspaceSummary,
} from "../../../shared/protocol.js";
import { ConversationList } from "./ConversationList.js";
import {
  networkPolicyIssueText,
  networkPolicyLabel,
  type WorkspaceFormValues,
} from "./WorkspaceForm.js";
import { WorkspaceDialog } from "./WorkspaceDialog.js";

interface WorkspaceUpdateValues {
  readonly name: string;
  readonly path?: string;
  readonly securityProfile?: WorkspaceSecurityProfile;
  readonly mounts?: readonly WorkspaceMount[];
  readonly networkPolicy?: SandboxNetworkPolicy;
  readonly networkPolicySetId?: string;
  readonly acknowledgeSecurityDowngrade?: true;
  readonly acknowledgeNetworkExposure?: true;
  readonly acknowledgeWritableMounts?: true;
}

export interface WorkspaceSidebarProps {
  readonly workspaces: readonly WorkspaceSummary[];
  readonly selectedWorkspaceId: string | null;
  readonly conversations: readonly ConversationSummary[];
  readonly liveStatuses: Readonly<Record<string, LiveConversationStatus>>;
  readonly liveWorkspaceIds: ReadonlySet<string>;
  readonly selectedConversationId: string | null;
  readonly connected: boolean;
  readonly historyPending: boolean;
  readonly historyError: string | null;
  readonly actionPending: boolean;
  readonly publicSandboxConfig: PublicSandboxConfig | undefined;
  readonly publicManagedEgressConfig: PublicManagedEgressConfig | undefined;
  readonly open: boolean;
  readonly onDismiss: () => void;
  readonly onSelectWorkspace: (workspaceId: string) => void;
  readonly onCreateWorkspace: (
    values: WorkspaceFormValues & { readonly acknowledgeWritableMounts?: true },
  ) => Promise<void>;
  readonly onUpdateWorkspace: (workspaceId: string, values: WorkspaceUpdateValues) => Promise<void>;
  readonly onRemoveWorkspace: (workspace: WorkspaceSummary) => Promise<void>;
  readonly onCreateConversation: () => Promise<void>;
  readonly onSelectConversation: (conversation: ConversationSummary) => void;
}

type WorkspacePanelMode =
  | { readonly type: "create" }
  | { readonly type: "edit"; readonly workspace: WorkspaceSummary }
  | { readonly type: "info"; readonly workspace: WorkspaceSummary };

function storageLabel(workspace: WorkspaceSummary): string {
  return workspace.sessionStorage === "workspace"
    ? "Stored in workspace"
    : "Pi default";
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function workspacePolicyIssueLabel(issue: WorkspacePolicyIssue): string {
  switch (issue) {
    case "sandbox_disabled":
      return "Workspace sandbox is disabled by the administrator.";
    case "outside_workspace_roots":
      return "Directory is outside administrator-approved workspace roots.";
    case "protected_path_overlap":
      return "Directory or mount overlaps a protected server or runtime location.";
    case "mount_unavailable":
      return "An additional filesystem mount is unavailable or inaccessible.";
    case null:
      return "No policy issue";
  }
}

export function securityDowngradeConfirmation(workspace: WorkspaceSummary): string {
  return `Change “${workspace.name}” from Workspace sandbox to Unrestricted? The model’s tools and commands will run with the full permissions of the ChatWCA server. This reduces protection.`;
}

export function writableMountConfirmation(workspaceName?: string): string {
  const target = workspaceName === undefined ? "this workspace" : `“${workspaceName}”`;
  return `Allow read-write filesystem mounts for ${target}? Sandboxed tools will be able to modify the selected server directories outside the workspace.`;
}

export function networkPolicyIssueLabel(issue: WorkspaceNetworkPolicyIssue): string {
  return networkPolicyIssueText(issue);
}

export function networkExposureConfirmation(workspaceName?: string): string {
  const target = workspaceName === undefined ? "this workspace" : `“${workspaceName}”`;
  return `Enable or change Managed egress for ${target}? Tools may transmit workspace content to destinations in the selected administrator-defined policy through a filtered proxy. Workspace content may also be sent to the configured model provider.`;
}

export function workspaceUpdatePlan(workspace: WorkspaceSummary, values: WorkspaceFormValues): {
  readonly downgrade: boolean;
  readonly addsNetworkExposure: boolean;
  readonly addsWritableMounts: boolean;
  readonly changes: WorkspaceUpdateValues;
} {
  const profileChanged = values.securityProfile !== workspace.securityProfile;
  const mountsChanged = JSON.stringify(values.mounts) !== JSON.stringify(workspace.mounts);
  const networkPolicyChanged = values.networkPolicy !== workspace.networkPolicy;
  const networkPolicySetChanged = values.networkPolicySetId !== workspace.networkPolicySetId;
  const downgrade = profileChanged &&
    workspace.securityProfile === "workspace-sandboxed" &&
    values.securityProfile === "unrestricted";
  const enablesManagedEgress =
    values.securityProfile === "workspace-sandboxed" &&
    values.networkPolicy === "managed-egress" &&
    !(workspace.securityProfile === "workspace-sandboxed" && workspace.networkPolicy === "managed-egress");
  const selectsManagedNetwork = workspace.networkPolicy === "isolated" &&
    values.networkPolicy === "managed-egress";
  const changesManagedSet = networkPolicySetChanged &&
    (workspace.networkPolicy === "managed-egress" || values.networkPolicy === "managed-egress");
  const addsNetworkExposure = enablesManagedEgress || selectsManagedNetwork || changesManagedSet;
  const previousMounts = new Map(workspace.mounts.map((mount) => [mount.name, mount]));
  const addsWritableMounts = mountsChanged && values.mounts.some((mount) => {
    if (mount.access !== "read-write") return false;
    const previous = previousMounts.get(mount.name);
    return previous === undefined || previous.access !== "read-write" || previous.source !== mount.source;
  });

  return {
    downgrade,
    addsNetworkExposure,
    addsWritableMounts,
    changes: {
      name: values.name,
      ...(values.path === workspace.path ? {} : { path: values.path }),
      ...(profileChanged ? { securityProfile: values.securityProfile } : {}),
      ...(mountsChanged ? { mounts: values.mounts } : {}),
      ...(networkPolicyChanged ? { networkPolicy: values.networkPolicy } : {}),
      ...(networkPolicySetChanged ? { networkPolicySetId: values.networkPolicySetId } : {}),
      ...(downgrade ? { acknowledgeSecurityDowngrade: true } : {}),
      ...(addsNetworkExposure ? { acknowledgeNetworkExposure: true } : {}),
      ...(addsWritableMounts ? { acknowledgeWritableMounts: true } : {}),
    },
  };
}

export function workspaceRemovalConfirmation(workspace: WorkspaceSummary): string {
  return `Remove workspace “${workspace.name}”? The directory at ${workspace.path} and all Pi sessions will be retained and will not be deleted.`;
}

export function sortWorkspacesByMostRecentlyUsed(
  workspaces: readonly WorkspaceSummary[],
  recentWorkspaceIds: readonly string[],
): WorkspaceSummary[] {
  const rank = new Map<string, number>();
  for (const workspaceId of recentWorkspaceIds) {
    if (!rank.has(workspaceId)) rank.set(workspaceId, rank.size);
  }

  return workspaces
    .map((workspace, index) => ({ workspace, index }))
    .sort((left, right) => {
      const leftRank = rank.get(left.workspace.id);
      const rightRank = rank.get(right.workspace.id);
      if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank;
      if (leftRank !== undefined) return -1;
      if (rightRank !== undefined) return 1;
      return left.index - right.index;
    })
    .map(({ workspace }) => workspace);
}

export function WorkspaceSidebar({
  workspaces,
  selectedWorkspaceId,
  conversations,
  liveStatuses,
  liveWorkspaceIds,
  selectedConversationId,
  connected,
  historyPending,
  historyError,
  actionPending,
  publicSandboxConfig,
  publicManagedEgressConfig,
  open,
  onDismiss,
  onSelectWorkspace,
  onCreateWorkspace,
  onUpdateWorkspace,
  onRemoveWorkspace,
  onCreateConversation,
  onSelectConversation,
}: WorkspaceSidebarProps) {
  const [formMode, setFormMode] = useState<WorkspacePanelMode | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [openMenuPosition, setOpenMenuPosition] = useState<{
    readonly top: number;
    readonly right: number;
  } | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [recentWorkspaceIds, setRecentWorkspaceIds] = useState<readonly string[]>([]);
  const formReturnFocus = useRef<HTMLButtonElement | null>(null);
  const openMenu = useRef<HTMLDivElement | null>(null);
  const openMenuTrigger = useRef<HTMLButtonElement | null>(null);
  const formWasOpen = useRef(false);
  const selectedWorkspace = workspaces.find((item) => item.id === selectedWorkspaceId) ?? null;
  const orderedWorkspaces = useMemo(
    () => sortWorkspacesByMostRecentlyUsed(
      workspaces,
      selectedWorkspaceId === null
        ? recentWorkspaceIds
        : [selectedWorkspaceId, ...recentWorkspaceIds],
    ),
    [recentWorkspaceIds, selectedWorkspaceId, workspaces],
  );

  useEffect(() => {
    const knownIds = new Set(workspaces.map((workspace) => workspace.id));
    setRecentWorkspaceIds((current) => {
      const candidates = selectedWorkspaceId === null
        ? current
        : [selectedWorkspaceId, ...current];
      const next = candidates.filter(
        (workspaceId, index) => knownIds.has(workspaceId) && candidates.indexOf(workspaceId) === index,
      );
      return next.length === current.length && next.every((id, index) => id === current[index])
        ? current
        : next;
    });
  }, [selectedWorkspaceId, workspaces]);

  useEffect(() => {
    if (formWasOpen.current && formMode === null) formReturnFocus.current?.focus();
    formWasOpen.current = formMode !== null;
  }, [formMode]);

  useEffect(() => {
    if (
      formMode !== null &&
      formMode.type !== "create" &&
      !workspaces.some((item) => item.id === formMode.workspace.id)
    ) {
      setFormMode(null);
      setWorkspaceError("The workspace was removed in another browser tab.");
    }
    if (openMenuId !== null && !workspaces.some((item) => item.id === openMenuId)) {
      setOpenMenuId(null);
    }
  }, [formMode, openMenuId, workspaces]);

  useEffect(() => {
    if (openMenuId === null || (formMode !== null && formMode.type !== "info")) return;

    function dismissOnOutsidePress(event: PointerEvent): void {
      if (
        event.target instanceof Node &&
        !openMenu.current?.contains(event.target) &&
        !openMenuTrigger.current?.contains(event.target)
      ) {
        setOpenMenuId(null);
      }
    }

    function dismissOnEscape(event: KeyboardEvent): void {
      if (event.key !== "Escape" || document.querySelector("[role='dialog'][aria-modal='true']") !== null) return;
      setOpenMenuId(null);
      openMenuTrigger.current?.focus();
    }

    document.addEventListener("pointerdown", dismissOnOutsidePress);
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissOnOutsidePress);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [formMode, openMenuId]);

  useEffect(() => {
    if (openMenuId === null) return;

    function updatePosition(): void {
      const trigger = openMenuTrigger.current;
      if (trigger === null) return;

      const triggerRect = trigger.getBoundingClientRect();
      const menuHeight = openMenu.current?.getBoundingClientRect().height ?? 0;
      const gap = 4;
      const viewportInset = 8;
      const below = triggerRect.bottom + gap;
      const top = menuHeight > 0 && below + menuHeight > window.innerHeight - viewportInset
        ? Math.max(viewportInset, triggerRect.top - gap - menuHeight)
        : below;

      setOpenMenuPosition({
        top,
        right: Math.max(viewportInset, window.innerWidth - triggerRect.right),
      });
    }

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [openMenuId]);

  async function submitWorkspace(values: WorkspaceFormValues): Promise<void> {
    if (formMode === null || submitting || actionPending) return;
    setSubmitting(true);
    setWorkspaceError(null);
    try {
      if (formMode.type === "create") {
        if (
          values.securityProfile === "workspace-sandboxed" &&
          values.networkPolicy === "managed-egress" &&
          !window.confirm(networkExposureConfirmation())
        ) {
          return;
        }
        const addsWritableMounts = values.mounts.some(({ access }) => access === "read-write");
        if (addsWritableMounts && !window.confirm(writableMountConfirmation())) return;
        await onCreateWorkspace({
          ...values,
          ...(addsWritableMounts ? { acknowledgeWritableMounts: true } : {}),
        });
      } else if (formMode.type === "edit") {
        const plan = workspaceUpdatePlan(formMode.workspace, values);
        if (plan.downgrade && !window.confirm(securityDowngradeConfirmation(formMode.workspace))) {
          return;
        }
        if (plan.addsNetworkExposure && !window.confirm(networkExposureConfirmation(formMode.workspace.name))) {
          return;
        }
        if (plan.addsWritableMounts && !window.confirm(writableMountConfirmation(formMode.workspace.name))) {
          return;
        }
        await onUpdateWorkspace(formMode.workspace.id, plan.changes);
      }
      setFormMode(null);
    } catch (error) {
      setWorkspaceError(messageOf(error, "Unable to save the workspace."));
    } finally {
      setSubmitting(false);
    }
  }

  async function removeWorkspace(workspace: WorkspaceSummary): Promise<void> {
    if (removingId !== null || actionPending) return;
    const confirmed = window.confirm(workspaceRemovalConfirmation(workspace));
    if (!confirmed) return;

    setOpenMenuId(null);
    setRemovingId(workspace.id);
    setWorkspaceError(null);
    try {
      await onRemoveWorkspace(workspace);
      if (formMode?.type === "edit" && formMode.workspace.id === workspace.id) {
        setFormMode(null);
      }
    } catch (error) {
      setWorkspaceError(messageOf(error, "Unable to remove the workspace."));
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <aside
      className={`conversation-sidebar workspace-sidebar${open ? " is-open" : ""}`}
      aria-label="Workspaces and conversations"
    >
      <div className="sidebar-brand">
        <div>
          <span className="brand-mark" aria-hidden="true">W</span>
          <div>
            <strong>ChatWCA</strong>
            <small>Local agent platform</small>
          </div>
        </div>
        <button
          className="icon-button sidebar-dismiss"
          type="button"
          onClick={onDismiss}
          aria-label="Close workspaces and conversations"
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>

      <section className="workspace-panel" aria-labelledby="workspace-list-heading">
        <div className="workspace-panel-header">
          <h2 id="workspace-list-heading">Workspaces</h2>
          <button
            className="workspace-add-button"
            type="button"
            disabled={!connected || publicSandboxConfig === undefined || actionPending || submitting || removingId !== null}
            aria-expanded={formMode?.type === "create"}
            onClick={(event) => {
              formReturnFocus.current = event.currentTarget;
              setFormMode({ type: "create" });
              setWorkspaceError(null);
            }}
          >
            <span aria-hidden="true">＋</span> Add
          </button>
        </div>

        {formMode !== null && formMode.type !== "info" && publicSandboxConfig !== undefined && publicManagedEgressConfig !== undefined && (
          <WorkspaceDialog
            key={formMode.type === "create" ? "create" : formMode.workspace.id}
            mode={formMode.type}
            {...(formMode.type === "edit" ? {
              initialValues: {
                name: formMode.workspace.name,
                path: formMode.workspace.path,
                sessionStorage: formMode.workspace.sessionStorage,
                securityProfile: formMode.workspace.securityProfile,
                mounts: formMode.workspace.mounts,
                networkPolicy: formMode.workspace.networkPolicy,
                networkPolicySetId: formMode.workspace.networkPolicySetId,
                effectiveSecurityProfile: formMode.workspace.effectiveSecurityProfile,
                effectiveNetworkPolicy: formMode.workspace.effectiveNetworkPolicy,
                effectiveNetworkPolicySetId: formMode.workspace.effectiveNetworkPolicySetId,
                networkPolicyIssue: formMode.workspace.networkPolicyIssue,
              },
            } : {})}
            publicSandboxConfig={publicSandboxConfig}
            publicManagedEgressConfig={publicManagedEgressConfig}
            securityControlsLocked={formMode.type === "edit" && liveWorkspaceIds.has(formMode.workspace.id)}
            submitting={submitting}
            error={workspaceError}
            returnFocusRef={formReturnFocus}
            onSubmit={submitWorkspace}
            onClose={() => {
              if (submitting) return;
              setFormMode(null);
              setWorkspaceError(null);
              window.requestAnimationFrame(() => formReturnFocus.current?.focus());
            }}
          />
        )}

        {formMode?.type === "info" && (
          <section
            className="workspace-info"
            aria-label={`Workspace info for ${formMode.workspace.name}`}
          >
            <h3>Workspace info</h3>
            <dl>
              <div>
                <dt>Name</dt>
                <dd>{formMode.workspace.name}</dd>
              </div>
              <div>
                <dt>Directory</dt>
                <dd><code>{formMode.workspace.path}</code></dd>
              </div>
              <div>
                <dt>Usability</dt>
                <dd>{!formMode.workspace.available
                  ? "Unavailable directory"
                  : formMode.workspace.usable
                    ? "Usable"
                    : `Policy blocked — ${formMode.workspace.networkPolicyIssue === null
                      ? workspacePolicyIssueLabel(formMode.workspace.policyIssue)
                      : networkPolicyIssueLabel(formMode.workspace.networkPolicyIssue)}`}</dd>
              </div>
              <div>
                <dt>Stored profile</dt>
                <dd>{formMode.workspace.securityProfile === "workspace-sandboxed" ? "Workspace sandbox" : "Unrestricted"}</dd>
              </div>
              <div>
                <dt>Effective profile</dt>
                <dd>{formMode.workspace.effectiveSecurityProfile === null
                  ? "None — policy blocked"
                  : formMode.workspace.effectiveSecurityProfile === "workspace-sandboxed"
                    ? "Workspace sandbox"
                    : "Unrestricted"}</dd>
              </div>
              <div>
                <dt>Server mode</dt>
                <dd>{publicSandboxConfig === undefined
                  ? "Configuration unavailable"
                  : publicSandboxConfig.mode === "required"
                    ? "Required — sandboxing is required"
                    : publicSandboxConfig.mode === "optional"
                      ? "Optional — sandboxing is not required"
                      : "Disabled — sandboxing is unavailable"}</dd>
              </div>
              <div>
                <dt>Stored network type</dt>
                <dd>{networkPolicyLabel(formMode.workspace.networkPolicy)}</dd>
              </div>
              <div>
                <dt>Effective network type</dt>
                <dd>{formMode.workspace.effectiveNetworkPolicy === null
                  ? "None — not a usable Workspace sandbox runtime"
                  : networkPolicyLabel(formMode.workspace.effectiveNetworkPolicy)}</dd>
              </div>
              <div>
                <dt>Stored destination policy</dt>
                <dd>{publicManagedEgressConfig?.policySets.find(({ id }) => id === formMode.workspace.networkPolicySetId)?.label ?? "Unavailable"} ({formMode.workspace.networkPolicySetId})</dd>
              </div>
              <div>
                <dt>Effective destination policy</dt>
                <dd>{formMode.workspace.effectiveNetworkPolicySetId === null
                  ? "None"
                  : `${publicManagedEgressConfig?.policySets.find(({ id }) => id === formMode.workspace.effectiveNetworkPolicySetId)?.label ?? "Unavailable"} (${formMode.workspace.effectiveNetworkPolicySetId})`}</dd>
              </div>
              <div>
                <dt>Network policy issue</dt>
                <dd>{networkPolicyIssueLabel(formMode.workspace.networkPolicyIssue)}</dd>
              </div>
              <div>
                <dt>Managed egress availability</dt>
                <dd>{publicManagedEgressConfig === undefined
                  ? "Configuration unavailable"
                  : publicManagedEgressConfig.selectablePolicies.includes("managed-egress") &&
                      publicManagedEgressConfig.functionalProbeSucceeded
                    ? "Available — startup functional probe passed"
                    : "Unavailable"}</dd>
              </div>
              <div>
                <dt>Session storage</dt>
                <dd>{storageLabel(formMode.workspace)}</dd>
              </div>
              <div>
                <dt>Session path</dt>
                <dd>{formMode.workspace.sessionDirectory === null
                  ? "Pi default server-managed directory"
                  : <code>{formMode.workspace.sessionDirectory}</code>}</dd>
              </div>
              <div>
                <dt>Selected policy domain patterns</dt>
                <dd className="workspace-info-values">{publicManagedEgressConfig?.policySets
                  .find(({ id }) => id === formMode.workspace.networkPolicySetId)?.allowedDomainPatterns
                  .map((pattern) => <code key={pattern}>{pattern}</code>) ?? "Unavailable"}</dd>
              </div>
              <div>
                <dt>Denied domain patterns</dt>
                <dd className="workspace-info-values">{publicManagedEgressConfig === undefined || publicManagedEgressConfig.deniedDomainPatterns.length === 0
                  ? "None configured"
                  : publicManagedEgressConfig.deniedDomainPatterns.map((pattern) => <code key={pattern}>{pattern}</code>)}</dd>
              </div>
              <div>
                <dt>Selected policy TCP ports</dt>
                <dd>{publicManagedEgressConfig?.policySets
                  .find(({ id }) => id === formMode.workspace.networkPolicySetId)?.allowedPorts.join(", ") ?? "Unavailable"}</dd>
              </div>
              <div>
                <dt>Supported protocols</dt>
                <dd>{publicManagedEgressConfig === undefined
                  ? "Configuration unavailable"
                  : publicManagedEgressConfig.supportedProtocols.join(", ")}</dd>
              </div>
              <div>
                <dt>Local and private destinations</dt>
                <dd>{publicManagedEgressConfig?.denyNonPublicAddresses === true
                  ? "Denied, including loopback, LAN, link-local, metadata, and other non-public addresses."
                  : "Configuration unavailable"}</dd>
              </div>
              <div>
                <dt>UDP and inbound connections</dt>
                <dd>Not supported. Managed egress permits outbound TCP through the configured proxies only.</dd>
              </div>
              <div>
                <dt>TLS interception</dt>
                <dd>{publicManagedEgressConfig === undefined
                  ? "Configuration unavailable"
                  : publicManagedEgressConfig.tlsInterception
                    ? "Enabled"
                    : "None — HTTPS remains end-to-end encrypted."}</dd>
              </div>
              <div>
                <dt>Additional filesystem mounts</dt>
                <dd className="workspace-info-values">{formMode.workspace.mounts.length === 0
                  ? "None"
                  : formMode.workspace.mounts.map((mount) => (
                      <span key={mount.name}>
                        <code>/mounts/{mount.name}</code> ← <code>{mount.source}</code> ({mount.access})
                      </span>
                    ))}</dd>
              </div>
              <div>
                <dt>Sandbox runtime</dt>
                <dd><code>/usr</code> and administrator-approved runtime mounts are read-only. Workspace-specific mounts use their configured access.</dd>
              </div>
            </dl>
            <div className="workspace-disclosures" role="note" aria-label="Workspace sandbox limitations">
              <p><strong>Writable files:</strong> The workspace, including <code>.git</code>, and every read-write mount can be modified. Sandboxing does not prevent harmful edits, hooks, or build scripts.</p>
              <p><strong>Managed network:</strong> {publicManagedEgressConfig?.disclosureWarning ?? "Tools may transmit workspace content to configured destinations."}</p>
              <p><strong>Remote model:</strong> {publicSandboxConfig?.remoteProviderWarning ?? "Workspace content may be sent to the configured model provider."}</p>
              <p><strong>No resource quotas:</strong> The sandbox does not isolate CPU, memory, or disk denial-of-service.</p>
            </div>
            <div className="form-actions">
              <button
                type="button"
                onClick={() => {
                  setFormMode(null);
                  setWorkspaceError(null);
                }}
              >
                Close
              </button>
            </div>
          </section>
        )}

        {workspaceError !== null && formMode === null && (
          <div className="workspace-error" role="alert">
            <span>{workspaceError}</span>
            <button type="button" aria-label="Dismiss workspace error" onClick={() => setWorkspaceError(null)}>×</button>
          </div>
        )}

        {workspaces.length === 0 ? (
          <div className="workspace-onboarding">
            <strong>Add your first workspace</strong>
            <p>Register a named project directory before starting a conversation.</p>
          </div>
        ) : (
          <ul className="workspace-list">
            {orderedWorkspaces.map((workspace) => {
              const selected = workspace.id === selectedWorkspaceId;
              const busy = actionPending || submitting || removingId !== null;
              const menuOpen = openMenuId === workspace.id;
              const menuId = `workspace-actions-${workspace.id}`;
              const actionsMenu = (
                <div
                  className={`workspace-actions-menu${menuOpen ? " workspace-actions-menu-portal" : ""}`}
                  id={menuId}
                  ref={menuOpen ? openMenu : undefined}
                  role="group"
                  aria-label={`Actions for ${workspace.name}`}
                  hidden={!menuOpen}
                  style={menuOpen && openMenuPosition !== null ? {
                    top: `${String(openMenuPosition.top)}px`,
                    right: `${String(openMenuPosition.right)}px`,
                  } : undefined}
                >
                  <button
                    type="button"
                    disabled={!connected || busy}
                    aria-label={`Workspace info ${workspace.name}`}
                    onClick={() => {
                      formReturnFocus.current = openMenuTrigger.current;
                      setOpenMenuId(null);
                      setFormMode({ type: "info", workspace });
                      setWorkspaceError(null);
                    }}
                  >
                    Info
                  </button>
                  <button
                    type="button"
                    disabled={!connected || publicSandboxConfig === undefined || publicManagedEgressConfig === undefined || busy}
                    aria-label={`Edit workspace ${workspace.name}`}
                    onClick={(event) => {
                      formReturnFocus.current = event.currentTarget;
                      setFormMode({ type: "edit", workspace });
                      setWorkspaceError(null);
                    }}
                  >
                    Edit
                  </button>
                  <button
                    className="workspace-remove-button"
                    type="button"
                    disabled={!connected || busy}
                    aria-label={`Remove workspace ${workspace.name}`}
                    onClick={() => void removeWorkspace(workspace)}
                  >
                    {removingId === workspace.id ? "Removing…" : "Remove"}
                  </button>
                </div>
              );
              return (
                <li
                  className={`workspace-item${selected ? " is-selected" : ""}${menuOpen ? " has-open-menu" : ""}`}
                  key={workspace.id}
                >
                  <button
                    className="workspace-select-button"
                    type="button"
                    disabled={busy}
                    aria-current={selected ? "true" : undefined}
                    onClick={() => onSelectWorkspace(workspace.id)}
                  >
                    <span className="workspace-name">
                      <strong>{workspace.name}</strong>
                      {!workspace.available ? (
                        <span className="workspace-unavailable">Unavailable</span>
                      ) : !workspace.usable ? (
                        <span className="workspace-policy-blocked" title={workspace.networkPolicyIssue === null
                          ? workspacePolicyIssueLabel(workspace.policyIssue)
                          : networkPolicyIssueLabel(workspace.networkPolicyIssue)}>Policy blocked</span>
                      ) : null}
                    </span>
                    <code title={workspace.path}>{workspace.path}</code>
                  </button>
                  <div className="workspace-item-menu">
                    <button
                      className="workspace-menu-trigger"
                      type="button"
                      disabled={!connected || busy}
                      aria-label={`Workspace actions for ${workspace.name}`}
                      aria-expanded={menuOpen}
                      aria-controls={menuId}
                      onClick={(event) => {
                        openMenuTrigger.current = event.currentTarget;
                        if (menuOpen) {
                          setOpenMenuId(null);
                          setOpenMenuPosition(null);
                          return;
                        }

                        const triggerRect = event.currentTarget.getBoundingClientRect();
                        setOpenMenuPosition({
                          top: triggerRect.bottom + 4,
                          right: Math.max(8, window.innerWidth - triggerRect.right),
                        });
                        setOpenMenuId(workspace.id);
                      }}
                    >
                      <span aria-hidden="true">…</span>
                    </button>
                    {!menuOpen && actionsMenu}
                  </div>
                  {menuOpen && typeof document !== "undefined" && createPortal(actionsMenu, document.body)}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <ConversationList
        workspace={selectedWorkspace}
        conversations={conversations}
        liveStatuses={liveStatuses}
        selectedConversationId={selectedConversationId}
        connected={connected}
        historyPending={historyPending}
        historyError={historyError}
        actionPending={actionPending || submitting || removingId !== null}
        onCreate={onCreateConversation}
        onSelect={onSelectConversation}
      />

      <div className="connection-summary" aria-live="polite">
        <span className={`connection-dot${connected ? " is-connected" : ""}`} />
        {connected ? "Connected" : "Connecting…"}
      </div>
    </aside>
  );
}
