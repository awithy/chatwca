import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  ConversationState,
  ConversationSummary,
  WorkspaceSummary,
} from "../../src/shared/protocol.js";
import { ConversationHeader } from "../../src/web/src/components/ConversationHeader.js";

const workspace: WorkspaceSummary = {
  id: "workspace-1",
  name: "Project",
  path: "/workspace",
  sessionStorage: "pi-default",
  sessionDirectory: null,
  securityProfile: "unrestricted",
  effectiveSecurityProfile: "unrestricted",
  createdAt: 1,
  updatedAt: 1,
  available: true,
  usable: true,
  policyIssue: null,
};

const summary: ConversationSummary = {
  id: "conversation-1",
  workspaceId: workspace.id,
  sessionFile: "/sessions/one.jsonl",
  title: "Context metrics",
  cwd: workspace.path,
  modifiedAt: 2,
  messageCount: 2,
  status: "idle",
  runnable: true,
};

function conversation(contextUsage: ConversationState["contextUsage"]): ConversationState {
  return {
    id: summary.id,
    workspaceId: workspace.id,
    sessionFile: summary.sessionFile,
    title: summary.title,
    cwd: workspace.path,
    model: {
      id: "model-1",
      provider: "test",
      supportsImages: false,
    },
    status: "idle",
    createdAt: 1,
    lastActiveAt: 2,
    revision: 1,
    durable: true,
    contextUsage,
    messages: [],
    queue: { steering: [], followUp: [] },
    securityProfile: "unrestricted",
  };
}

function renderHeader(contextUsage: ConversationState["contextUsage"]): string {
  return renderToStaticMarkup(createElement(ConversationHeader, {
    conversation: conversation(contextUsage),
    summary,
    workspace,
    loading: false,
    connected: true,
    actionPending: null,
    onRename: async () => undefined,
    onClose: () => undefined,
    onDelete: () => undefined,
  }));
}

describe("conversation header context usage", () => {
  it("shows an always-visible badge sourced from immutable conversation state", () => {
    const unrestricted = renderHeader(null);
    expect(unrestricted).toContain("Unrestricted");
    expect(unrestricted).toContain('aria-label="Conversation security profile: Unrestricted"');

    const sandboxed = renderToStaticMarkup(createElement(ConversationHeader, {
      conversation: { ...conversation(null), securityProfile: "workspace-sandboxed" },
      summary,
      workspace: { ...workspace, securityProfile: "unrestricted" },
      loading: false,
      connected: true,
      actionPending: null,
      onRename: async () => undefined,
      onClose: () => undefined,
      onDelete: () => undefined,
    }));
    expect(sandboxed).toContain(">Sandboxed</span>");
    expect(sandboxed).not.toContain("Conversation security profile: Unrestricted");
  });

  it("shows Pi-style percentage and compact context-window metrics", () => {
    const html = renderHeader({
      tokens: 14_144,
      contextWindow: 272_000,
      percent: 5.2,
    });

    expect(html).toContain("Context");
    expect(html).toContain("5.2%/272k");
    expect(html).toContain("14,144 of 272,000 context tokens");
  });

  it("shows an unknown percentage immediately after compaction", () => {
    const html = renderHeader({
      tokens: null,
      contextWindow: 272_000,
      percent: null,
    });

    expect(html).toContain("?/272k");
    expect(html).toContain("Context usage unknown · 272,000 token window");
  });
});
