import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { WorkspaceSummary } from "../../src/shared/protocol.js";
import { WorkspaceForm } from "../../src/web/src/components/WorkspaceForm.js";
import {
  WorkspaceSidebar,
  workspaceRemovalConfirmation,
} from "../../src/web/src/components/WorkspaceSidebar.js";

const workspace: WorkspaceSummary = {
  id: "workspace-1",
  name: "Deep Project",
  path: "/srv/projects/a/very/long/full/path/to/deep-project",
  createdAt: 1,
  updatedAt: 2,
  available: true,
};

function sidebar(workspaces: readonly WorkspaceSummary[], selectedWorkspaceId: string | null): string {
  return renderToStaticMarkup(createElement(WorkspaceSidebar, {
    workspaces,
    selectedWorkspaceId,
    conversations: [],
    liveStatuses: {},
    selectedConversationId: null,
    connected: true,
    historyPending: false,
    historyError: null,
    actionPending: false,
    open: false,
    onDismiss: () => undefined,
    onSelectWorkspace: () => undefined,
    onCreateWorkspace: async () => undefined,
    onUpdateWorkspace: async () => undefined,
    onRemoveWorkspace: async () => undefined,
    onCreateConversation: async () => undefined,
    onSelectConversation: () => undefined,
  }));
}

describe("workspace-first sidebar", () => {
  it("uses workspace-first ARIA, displays full paths, and offers labeled management actions", () => {
    const html = sidebar([workspace], workspace.id);

    expect(html).toContain('aria-label="Workspaces and conversations"');
    expect(html).toContain(workspace.path);
    expect(html).toContain('aria-label="Workspace actions for Deep Project"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Edit workspace Deep Project"');
    expect(html).toContain('aria-label="Remove workspace Deep Project"');
    expect(html).toContain('aria-current="true"');
    expect(html).not.toContain("Working directory");
    expect(html).not.toContain("All workspaces");
  });

  it("onboards without selecting or loading conversation history", () => {
    const empty = sidebar([], null);
    expect(empty).toContain("Add your first workspace");
    expect(empty).toContain("Select a workspace to load its conversations.");
  });

  it("marks unavailable workspaces and prevents new conversations", () => {
    const html = sidebar([{ ...workspace, available: false }], workspace.id);
    expect(html).toContain("Unavailable");
    expect(html).toContain("Workspace unavailable");
    expect(html).toMatch(/<button class="new-conversation-button"[^>]*disabled=""[^>]*aria-label="New conversation in Deep Project"/);
  });

  it("states retention explicitly before workspace removal", () => {
    const copy = workspaceRemovalConfirmation(workspace);
    expect(copy).toContain("directory at");
    expect(copy).toContain("Pi sessions will be retained");
    expect(copy).toContain("will not be deleted");
  });
});

describe("workspace form", () => {
  it("renders accessible create fields and a stable server error", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceForm, {
      mode: "create",
      submitting: false,
      error: "That workspace path is already registered.",
      onSubmit: async () => undefined,
      onCancel: () => undefined,
    }));

    expect(html).toContain('aria-label="Create workspace"');
    expect(html).toContain("Name");
    expect(html).toContain("Directory path");
    expect(html).toContain("autofocus");
    expect(html).toContain('role="alert"');
    expect(html).toContain("That workspace path is already registered.");
  });

  it("supports renaming and repointing with explicit edit labels", () => {
    const html = renderToStaticMarkup(createElement(WorkspaceForm, {
      mode: "edit",
      initialValues: { name: workspace.name, path: workspace.path },
      submitting: true,
      error: null,
      onSubmit: async () => undefined,
      onCancel: () => undefined,
    }));

    expect(html).toContain('aria-label="Edit workspace"');
    expect(html).toContain('value="Deep Project"');
    expect(html).toContain(workspace.path);
    expect(html).toContain("Saving…");
  });
});
