import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  ClientCommandSchema,
  ConversationStateSchema,
  PublicConfigSchema,
  ServerMessageSchema,
  WorkspaceSchema,
  WorkspaceSummarySchema,
  type CommandSuccessByType,
} from "../../src/shared/protocol.js";

const requestId = "request-1";

const commands = [
  { type: "workspace.list", requestId },
  {
    type: "workspace.create",
    requestId,
    name: "Example",
    path: "/workspace",
    sessionStorage: "pi-default",
    securityProfile: "unrestricted",
  },
  {
    type: "workspace.update",
    requestId,
    workspaceId: "workspace-1",
    name: "Renamed",
  },
  {
    type: "workspace.update",
    requestId,
    workspaceId: "workspace-1",
    path: "/other-workspace",
  },
  {
    type: "workspace.delete",
    requestId,
    workspaceId: "workspace-1",
  },
  { type: "history.list", requestId, workspaceId: "workspace-1" },
  { type: "conversation.create", requestId, workspaceId: "workspace-1" },
  {
    type: "conversation.open",
    requestId,
    workspaceId: "workspace-1",
    conversationId: "session-1",
  },
  { type: "conversation.state", requestId, conversationId: "session-1" },
  { type: "conversation.close", requestId, conversationId: "session-1" },
  {
    type: "conversation.delete",
    requestId,
    workspaceId: "workspace-1",
    conversationId: "session-1",
  },
  {
    type: "conversation.fork",
    requestId,
    conversationId: "session-1",
    entryId: "entry-1",
  },
  {
    type: "conversation.rewind",
    requestId,
    conversationId: "session-1",
    entryId: "entry-1",
  },
  {
    type: "prompt.submit",
    requestId,
    conversationId: "session-1",
    text: "hello",
    images: [],
  },
  {
    type: "prompt.steer",
    requestId,
    conversationId: "session-1",
    text: "change direction",
    images: [],
  },
  {
    type: "prompt.followUp",
    requestId,
    conversationId: "session-1",
    text: "then do this",
    images: [],
  },
  { type: "conversation.abort", requestId, conversationId: "session-1" },
] as const;

const conversationState = {
  id: "session-1",
  workspaceId: "workspace-1",
  sessionFile: "/sessions/session-1.jsonl",
  title: "Example",
  cwd: "/workspace",
  model: {
    id: "model-1",
    provider: "test",
    supportsImages: true,
  },
  status: "idle",
  createdAt: 1,
  lastActiveAt: 2,
  revision: 0,
  durable: true,
  contextUsage: { tokens: 14_144, contextWindow: 272_000, percent: 5.2 },
  messages: [
    {
      entryId: "entry-1",
      role: "user",
      forkEligible: false,
      blocks: [
        { type: "text", text: "hello" },
        {
          type: "image",
          image: {
            mimeType: "image/png",
            encoding: "base64",
            data: "iVBORw0KGgo=",
          },
        },
      ],
    },
    {
      entryId: "entry-2",
      role: "assistant",
      blocks: [
        { type: "thinking", text: "Working" },
        { type: "text", text: "Done" },
        {
          type: "tool-call",
          toolCallId: "tool-1",
          toolName: "read",
          arguments: { path: "README.md" },
          status: "succeeded",
        },
        {
          type: "tool-result",
          toolCallId: "tool-1",
          toolName: "read",
          content: "contents",
          isError: false,
          truncated: false,
        },
      ],
      stopReason: "stop",
    },
  ],
  queue: { steering: [], followUp: [] },
  securityProfile: "unrestricted",
  networkPolicy: null,
} as const;

describe("ClientCommandSchema", () => {
  it("accepts every command in the v1 protocol", () => {
    for (const command of commands) {
      expect(Value.Check(ClientCommandSchema, command)).toBe(true);
    }
  });

  it("requires request and workspace IDs at scoped command boundaries", () => {
    expect(Value.Check(ClientCommandSchema, {
      type: "history.list",
      workspaceId: "workspace-1",
    })).toBe(false);
    expect(Value.Check(ClientCommandSchema, {
      type: "history.list",
      requestId,
    })).toBe(false);
    expect(Value.Check(ClientCommandSchema, {
      type: "conversation.create",
      requestId,
      cwd: "/workspace",
    })).toBe(false);
    expect(Value.Check(ClientCommandSchema, {
      type: "conversation.open",
      requestId,
      conversationId: "session-1",
    })).toBe(false);
    expect(Value.Check(ClientCommandSchema, {
      type: "conversation.delete",
      requestId,
      conversationId: "session-1",
    })).toBe(false);
  });

  it("requires storage and security policy at creation and closes update objects", () => {
    expect(
      Value.Check(ClientCommandSchema, {
        type: "workspace.create",
        requestId,
        name: "Missing policy",
        path: "/workspace",
      }),
    ).toBe(false);
    expect(
      Value.Check(ClientCommandSchema, {
        type: "workspace.create",
        requestId,
        name: "Missing security profile",
        path: "/workspace",
        sessionStorage: "workspace",
      }),
    ).toBe(false);
    expect(Value.Check(ClientCommandSchema, {
      type: "workspace.update",
      requestId,
      workspaceId: "workspace-1",
      securityProfile: "workspace-sandboxed",
    })).toBe(true);
    expect(Value.Check(ClientCommandSchema, {
      type: "workspace.update",
      requestId,
      workspaceId: "workspace-1",
      securityProfile: "unrestricted",
      acknowledgeSecurityDowngrade: true,
    })).toBe(true);
    for (const acceptedForRepositoryValidation of [
      { name: "Renamed", acknowledgeSecurityDowngrade: true },
      { securityProfile: "workspace-sandboxed", acknowledgeSecurityDowngrade: true },
      { networkPolicy: "managed-egress", acknowledgeNetworkExposure: true },
    ]) {
      expect(Value.Check(ClientCommandSchema, {
        type: "workspace.update",
        requestId,
        workspaceId: "workspace-1",
        ...acceptedForRepositoryValidation,
      })).toBe(true);
    }
    expect(Value.Check(ClientCommandSchema, {
      type: "workspace.update",
      requestId,
      workspaceId: "workspace-1",
      name: "Renamed",
      sessionStorage: "workspace",
    })).toBe(false);
  });

  it("leaves non-empty update enforcement to the repository", () => {
    expect(
      Value.Check(ClientCommandSchema, {
        type: "workspace.update",
        requestId,
        workspaceId: "workspace-1",
      }),
    ).toBe(true);
    expect(
      Value.Check(ClientCommandSchema, {
        type: "workspace.update",
        requestId,
        workspaceId: "workspace-1",
        name: "Renamed",
        ignored: true,
      }),
    ).toBe(false);
  });

  it("rejects unknown command types and extra properties", () => {
    expect(
      Value.Check(ClientCommandSchema, {
        type: "conversation.rename",
        requestId,
      }),
    ).toBe(false);
    expect(
      Value.Check(ClientCommandSchema, {
        type: "history.list",
        requestId,
        ignored: true,
      }),
    ).toBe(false);
  });

  it("rejects unsupported and malformed image payloads", () => {
    const base = {
      type: "prompt.submit",
      requestId,
      conversationId: "session-1",
      text: "",
    };

    expect(
      Value.Check(ClientCommandSchema, {
        ...base,
        images: [
          {
            mimeType: "image/gif",
            encoding: "base64",
            data: "AAAA",
          },
        ],
      }),
    ).toBe(false);
    expect(
      Value.Check(ClientCommandSchema, {
        ...base,
        images: [
          { mimeType: "image/png", encoding: "data-url", data: "AAAA" },
        ],
      }),
    ).toBe(false);
  });
});

describe("public configuration schema", () => {
  it("accepts only the client-safe managed-egress projection", () => {
    const config = {
      maxImages: 4,
      maxImageBytes: 1024,
      maxTotalImageBytes: 4096,
      sandbox: {
        mode: "optional",
        selectableProfiles: ["unrestricted", "workspace-sandboxed"],
        remoteProviderWarning: "Model disclosure",
        functionalProbeSucceeded: true,
      },
      managedEgress: {
        mode: "optional",
        selectablePolicies: ["isolated", "managed-egress"],
        allowedDomainPatterns: ["example.com"],
        deniedDomainPatterns: ["deny.example"],
        allowedPorts: [443],
        supportedProtocols: ["http", "https-connect", "socks5-tcp"],
        denyNonPublicAddresses: true,
        tlsInterception: false,
        disclosureWarning: "Workspace disclosure",
        functionalProbeSucceeded: false,
      },
    } as const;
    expect(Value.Check(PublicConfigSchema, config)).toBe(true);
    expect(Value.Check(PublicConfigSchema, {
      ...config,
      managedEgress: { ...config.managedEgress, helperPath: "/private/helper" },
    })).toBe(false);
  });
});

describe("workspace schemas", () => {
  const workspace = {
    id: "workspace-1",
    name: "Example",
    path: "/workspace",
    sessionStorage: "pi-default",
    sessionDirectory: null,
    securityProfile: "unrestricted",
    networkPolicy: "isolated",
    createdAt: 10,
    updatedAt: 20,
  } as const;

  it("defines closed workspace records and availability summaries", () => {
    expect(Value.Check(WorkspaceSchema, workspace)).toBe(true);
    expect(
      Value.Check(WorkspaceSummarySchema, {
        ...workspace,
        available: true,
        effectiveSecurityProfile: "unrestricted",
        effectiveNetworkPolicy: null,
        networkPolicyIssue: null,
        usable: true,
        policyIssue: null,
      }),
    ).toBe(true);
    expect(
      Value.Check(WorkspaceSummarySchema, {
        ...workspace,
        available: true,
        effectiveSecurityProfile: "unrestricted",
        effectiveNetworkPolicy: null,
        networkPolicyIssue: null,
        usable: true,
        policyIssue: null,
        privateMetadata: "no",
      }),
    ).toBe(false);
  });

  it("types workspace command successes as exact correlated responses", () => {
    const listResponse = {
      type: "workspaces",
      requestId,
      workspaces: [{
        ...workspace,
        available: true,
        effectiveSecurityProfile: "unrestricted",
        effectiveNetworkPolicy: null,
        networkPolicyIssue: null,
        usable: true,
        policyIssue: null,
      }],
    } satisfies CommandSuccessByType["workspace.list"];
    const createResponse = listResponse satisfies CommandSuccessByType["workspace.create"];
    const updateResponse = listResponse satisfies CommandSuccessByType["workspace.update"];
    const deleteResponse = {
      type: "ack",
      requestId,
      command: "workspace.delete",
    } satisfies CommandSuccessByType["workspace.delete"];

    expect([createResponse, updateResponse, deleteResponse]).toHaveLength(3);
  });
});

describe("normalized conversation state", () => {
  it("accepts workspace-owned messages containing all normalized block categories", () => {
    expect(Value.Check(ConversationStateSchema, conversationState)).toBe(true);
    const { workspaceId: _workspaceId, ...unowned } = conversationState;
    expect(Value.Check(ConversationStateSchema, unowned)).toBe(false);
  });

  it("requires explicit server-derived fork eligibility on user messages", () => {
    const [user, assistant] = conversationState.messages;
    expect(
      Value.Check(ConversationStateSchema, {
        ...conversationState,
        messages: [{ ...user, forkEligible: true }, assistant],
      }),
    ).toBe(true);
    const { forkEligible: _forkEligible, ...unmarkedUser } = user;
    expect(
      Value.Check(ConversationStateSchema, {
        ...conversationState,
        messages: [unmarkedUser, assistant],
      }),
    ).toBe(false);
  });

  it("validates context usage metrics", () => {
    expect(Value.Check(ConversationStateSchema, {
      ...conversationState,
      contextUsage: { tokens: null, contextWindow: 272_000, percent: null },
    })).toBe(true);
    expect(Value.Check(ConversationStateSchema, {
      ...conversationState,
      contextUsage: { tokens: -1, contextWindow: 272_000, percent: -0.1 },
    })).toBe(false);
  });

  it("applies the closed-object policy recursively", () => {
    expect(
      Value.Check(ConversationStateSchema, {
        ...conversationState,
        queue: { steering: [], followUp: [], unknown: [] },
      }),
    ).toBe(false);
  });
});

describe("ServerMessageSchema", () => {
  it("accepts acknowledgements, correlated errors, snapshots, and events", () => {
    const messages = [
      { type: "ready", serverVersion: "0.0.0" },
      {
        type: "workspaces",
        requestId,
        workspaces: [
          {
            id: "workspace-1",
            name: "Example",
            path: "/workspace",
            sessionStorage: "workspace",
            sessionDirectory: "/workspace/.chatwca/sessions",
            securityProfile: "workspace-sandboxed",
            networkPolicy: "isolated",
            effectiveSecurityProfile: "workspace-sandboxed",
            effectiveNetworkPolicy: "isolated",
            networkPolicyIssue: null,
            createdAt: 1,
            updatedAt: 2,
            available: true,
            usable: true,
            policyIssue: null,
          },
        ],
      },
      { type: "workspaces", workspaces: [] },
      {
        type: "ack",
        requestId,
        command: "prompt.submit",
      },
      {
        type: "error",
        requestId,
        code: "invalid_command",
        message: "Invalid command",
      },
      {
        type: "history",
        requestId,
        workspaceId: "workspace-1",
        conversations: [
          {
            id: "session-1",
            workspaceId: "workspace-1",
            sessionFile: "/sessions/session-1.jsonl",
            title: "Example",
            cwd: "/workspace",
            modifiedAt: 2,
            messageCount: 2,
            status: "idle",
            runnable: true,
          },
        ],
      },
      { type: "state", requestId, conversation: conversationState },
      {
        type: "message.delta",
        workspaceId: "workspace-1",
        conversationId: "session-1",
        revision: 1,
        payload: {
          entryId: "entry-2",
          blockIndex: 1,
          blockType: "text",
          delta: "Done",
        },
      },
      {
        type: "conversation.notice",
        workspaceId: "workspace-1",
        conversationId: "session-1",
        revision: 2,
        payload: {
          notice: {
            kind: "retry",
            phase: "scheduled",
            message: "Retrying",
            attempt: 1,
            maxAttempts: 3,
            delayMs: 100,
          },
        },
      },
      {
        type: "network.blocked",
        workspaceId: "workspace-1",
        conversationId: "session-1",
        revision: 3,
        payload: {
          host: "example.com",
          port: 443,
          protocol: "https-connect",
          reason: "not_allowed",
          occurrenceCount: 4,
        },
      },
    ];

    for (const message of messages) {
      expect(Value.Check(ServerMessageSchema, message)).toBe(true);
    }
    expect(Value.Check(ServerMessageSchema, {
      type: "history",
      conversations: [],
    })).toBe(false);
    expect(Value.Check(ServerMessageSchema, {
      type: "conversation.status",
      conversationId: "session-1",
      revision: 1,
      payload: { status: "idle" },
    })).toBe(false);
  });

  it("keeps blocked-network events bounded and closed", () => {
    const event = {
      type: "network.blocked",
      workspaceId: "workspace-1",
      conversationId: "session-1",
      revision: 1,
      payload: {
        host: "example.com",
        port: 443,
        protocol: "https-connect",
        reason: "explicit_deny",
      },
    };
    expect(Value.Check(ServerMessageSchema, event)).toBe(true);
    expect(Value.Check(ServerMessageSchema, {
      ...event,
      payload: { ...event.payload, url: "https://example.com/private?token=secret" },
    })).toBe(false);
    expect(Value.Check(ServerMessageSchema, {
      ...event,
      payload: { ...event.payload, reason: "exception:/private/path" },
    })).toBe(false);
  });

  it("requires safe non-negative snapshot and positive event revisions", () => {
    expect(
      Value.Check(ServerMessageSchema, {
        type: "state",
        conversation: { ...conversationState, revision: -1 },
      }),
    ).toBe(false);
    expect(
      Value.Check(ServerMessageSchema, {
        type: "state",
        conversation: {
          ...conversationState,
          revision: Number.MAX_SAFE_INTEGER + 1,
        },
      }),
    ).toBe(false);
    expect(
      Value.Check(ServerMessageSchema, {
        type: "conversation.status",
        workspaceId: "workspace-1",
        conversationId: "session-1",
        revision: 0,
        payload: { status: "streaming" },
      }),
    ).toBe(false);
  });

  it("acknowledges only commands whose success has no result payload", () => {
    expect(
      Value.Check(ServerMessageSchema, {
        type: "ack",
        requestId,
        command: "conversation.close",
      }),
    ).toBe(true);
    expect(
      Value.Check(ServerMessageSchema, {
        type: "ack",
        requestId,
        command: "workspace.delete",
      }),
    ).toBe(true);
    expect(
      Value.Check(ServerMessageSchema, {
        type: "ack",
        requestId,
        command: "conversation.create",
      }),
    ).toBe(false);
  });
});
