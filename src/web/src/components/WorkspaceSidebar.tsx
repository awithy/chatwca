import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import type {
  ConversationSummary,
  LiveConversationStatus,
  WorkspaceSummary,
} from "../../../shared/protocol.js";
import { ConversationList } from "./ConversationList.js";
import { WorkspaceForm, type WorkspaceFormValues } from "./WorkspaceForm.js";

interface WorkspaceUpdateValues {
  readonly name: string;
  readonly path?: string;
}

export interface WorkspaceSidebarProps {
  readonly workspaces: readonly WorkspaceSummary[];
  readonly selectedWorkspaceId: string | null;
  readonly conversations: readonly ConversationSummary[];
  readonly liveStatuses: Readonly<Record<string, LiveConversationStatus>>;
  readonly selectedConversationId: string | null;
  readonly connected: boolean;
  readonly historyPending: boolean;
  readonly historyError: string | null;
  readonly actionPending: boolean;
  readonly open: boolean;
  readonly onDismiss: () => void;
  readonly onSelectWorkspace: (workspaceId: string) => void;
  readonly onCreateWorkspace: (values: WorkspaceFormValues) => Promise<void>;
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
  selectedConversationId,
  connected,
  historyPending,
  historyError,
  actionPending,
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
    if (openMenuId === null) return;

    function dismissOnOutsidePress(event: PointerEvent): void {
      if (event.target instanceof Node && !openMenu.current?.contains(event.target)) {
        setOpenMenuId(null);
      }
    }

    function dismissOnEscape(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      setOpenMenuId(null);
      openMenuTrigger.current?.focus();
    }

    document.addEventListener("pointerdown", dismissOnOutsidePress);
    document.addEventListener("keydown", dismissOnEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissOnOutsidePress);
      document.removeEventListener("keydown", dismissOnEscape);
    };
  }, [openMenuId]);

  async function submitWorkspace(values: WorkspaceFormValues): Promise<void> {
    if (formMode === null || submitting || actionPending) return;
    setSubmitting(true);
    setWorkspaceError(null);
    try {
      if (formMode.type === "create") {
        await onCreateWorkspace(values);
      } else if (formMode.type === "edit") {
        await onUpdateWorkspace(formMode.workspace.id, {
          name: values.name,
          ...(values.path === formMode.workspace.path ? {} : { path: values.path }),
        });
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
            <small>Pi coding agent</small>
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
            disabled={!connected || actionPending || submitting || removingId !== null}
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

        {formMode !== null && formMode.type !== "info" && (
          <WorkspaceForm
            key={formMode.type === "create" ? "create" : formMode.workspace.id}
            mode={formMode.type}
            {...(formMode.type === "edit" ? {
              initialValues: {
                name: formMode.workspace.name,
                path: formMode.workspace.path,
                sessionStorage: formMode.workspace.sessionStorage,
              },
            } : {})}
            submitting={submitting}
            error={workspaceError}
            onSubmit={submitWorkspace}
            onCancel={() => {
              setFormMode(null);
              setWorkspaceError(null);
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
                <dt>Availability</dt>
                <dd>{formMode.workspace.available ? "Available" : "Unavailable"}</dd>
              </div>
              <div>
                <dt>Session storage</dt>
                <dd>{storageLabel(formMode.workspace)}</dd>
              </div>
              {formMode.workspace.sessionDirectory !== null && (
                <div>
                  <dt>Session directory</dt>
                  <dd><code>{formMode.workspace.sessionDirectory}</code></dd>
                </div>
              )}
            </dl>
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
                      {!workspace.available && <span className="workspace-unavailable">Unavailable</span>}
                    </span>
                    <code title={workspace.path}>{workspace.path}</code>
                  </button>
                  <div
                    className="workspace-item-menu"
                    ref={menuOpen ? openMenu : undefined}
                  >
                    <button
                      className="workspace-menu-trigger"
                      type="button"
                      disabled={!connected || busy}
                      aria-label={`Workspace actions for ${workspace.name}`}
                      aria-expanded={menuOpen}
                      aria-controls={menuId}
                      onClick={(event) => {
                        openMenuTrigger.current = event.currentTarget;
                        setOpenMenuId(menuOpen ? null : workspace.id);
                      }}
                    >
                      <span aria-hidden="true">…</span>
                    </button>
                    <div
                      className="workspace-actions-menu"
                      id={menuId}
                      role="group"
                      aria-label={`Actions for ${workspace.name}`}
                      hidden={!menuOpen}
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
                        disabled={!connected || busy}
                        aria-label={`Edit workspace ${workspace.name}`}
                        onClick={() => {
                          formReturnFocus.current = openMenuTrigger.current;
                          setOpenMenuId(null);
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
                  </div>
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
