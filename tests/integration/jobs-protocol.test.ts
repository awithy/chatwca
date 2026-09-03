import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { loadConfig } from "../../src/server/config.js";
import { createChatWcaServer, type ChatWcaServer } from "../../src/server/index.js";
import { summaryOnly, type JobServiceListener } from "../../src/server/job-service.js";
import type {
  ProtocolHistory,
  ProtocolJobs,
  ProtocolRegistry,
  ProtocolWorkspaceRepository,
} from "../../src/server/protocol.js";
import type {
  ConversationState,
  JobRunState,
  JobSummary,
  ServerMessage,
  WorkspaceSummary,
} from "../../src/shared/protocol.js";

const servers: ChatWcaServer[] = [];

const workspace: WorkspaceSummary = {
  id: "workspace-1", name: "Workspace", path: "/workspace",
  sessionStorage: "pi-default", sessionDirectory: null,
  securityProfile: "unrestricted", mounts: [], networkPolicy: "isolated",
  effectiveSecurityProfile: "unrestricted", effectiveNetworkPolicy: null,
  networkPolicySetId: "default", effectiveNetworkPolicySetId: null,
  networkPolicyIssue: null, createdAt: 1, updatedAt: 1,
  available: true, usable: true, policyIssue: null,
};
const conversation: ConversationState = {
  id: "conversation-1", workspaceId: workspace.id, sessionFile: "/sessions/one.jsonl",
  title: "One", cwd: workspace.path, model: null, status: "idle", createdAt: 1,
  lastActiveAt: 1, revision: 0, durable: true, contextUsage: null, messages: [],
  queue: { steering: [], followUp: [] }, securityProfile: "unrestricted",
  networkPolicy: null, networkPolicySetId: "default", effectiveNetworkPolicySetId: null,
};
const queued: JobRunState = {
  id: "run-1", jobId: "job-1", trigger: "manual", scheduledFor: 1,
  startedAt: null, finishedAt: null, status: "queued", phase: null,
  errorCode: null, errorMessage: null, conversationId: null, revision: 0,
  createdAt: 1, updatedAt: 1, preExitCode: null, preStdout: null, preStderr: null,
  postExitCode: null, postStdout: null, postStderr: null, conversationAvailable: false,
};
const job: JobSummary = {
  id: "job-1", name: "Job", workspaceId: workspace.id, workspaceName: workspace.name,
  workspaceAvailable: true, prompt: "Do work",
  schedule: { kind: "daily", localTime: "07:00", timeZone: "UTC" },
  preRunScript: null, postRunScript: null, enabled: true, nextRunAt: 86_400_000,
  createdAt: 1, updatedAt: 1, activeRun: summaryOnly(queued), lastRun: null,
  configurationIssue: null,
};

function nextMessage(socket: WebSocket): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => resolve(JSON.parse(data.toString()) as ServerMessage));
    socket.once("error", reject);
  });
}

async function close(server: ChatWcaServer): Promise<void> {
  for (const socket of server.webSocketServer.clients) socket.terminate();
  await new Promise<void>((resolve) => server.webSocketServer.close(() => resolve()));
  await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
}

afterEach(async () => Promise.all(servers.splice(0).map(close)));

function services() {
  let listener: JobServiceListener | undefined;
  let rows: JobSummary[] = [];
  let detachedExecutions = 0;
  const jobs: ProtocolJobs = {
    list: () => [...rows],
    create: () => { rows = [job]; return rows; },
    update: () => rows,
    delete: () => { rows = []; return rows; },
    referencesWorkspace: () => rows.length > 0,
    run: () => {
      detachedExecutions += 1;
      return queued;
    },
    abort: vi.fn(async () => undefined),
    runs: () => ({ runs: [summaryOnly(queued)] }),
    runState: () => queued,
    subscribe: (next) => { listener = next; return () => { listener = undefined; }; },
  };
  const registry: ProtocolRegistry = {
    create: vi.fn(async () => ({ id: conversation.id })), open: vi.fn(async () => ({ id: conversation.id })),
    getState: vi.fn(async () => conversation), rename: vi.fn(async () => conversation),
    close: vi.fn(async () => undefined), fork: vi.fn(async () => ({ conversation, editorText: "" })),
    prompt: vi.fn(async () => undefined), abort: vi.fn(async () => undefined),
    hasLiveWorkspace: () => false, subscribe: () => () => undefined,
  };
  const history: ProtocolHistory = {
    list: vi.fn(async () => []), resolve: vi.fn(), delete: vi.fn(async () => []),
  };
  const workspaces: ProtocolWorkspaceRepository = {
    list: () => [workspace], requireAvailable: () => workspace,
    requireUsable: () => ({ workspaceId: workspace.id, cwd: workspace.path,
      sessionDirectory: null, securityProfile: "unrestricted" }),
    create: () => workspace, update: () => workspace, delete: vi.fn(),
  };
  return {
    jobs, registry, history, workspaces,
    emit: (event: Parameters<JobServiceListener>[0]) => listener?.(event),
    detachedExecutions: () => detachedExecutions,
  };
}

async function start() {
  const f = services();
  const server = createChatWcaServer(
    loadConfig({ CHATWCA_DATA_DIR: "/tmp" }, "/tmp"), "jobs-protocol", f,
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.httpServer.listen(0, "127.0.0.1", resolve));
  const port = (server.httpServer.address() as AddressInfo).port;
  return { ...f, server, url: `ws://127.0.0.1:${String(port)}/ws` };
}

describe("scheduled jobs over WebSocket", () => {
  it("correlates snapshots, broadcasts summary-only revisions, and continues after disconnect", async () => {
    const f = await start();
    const first = new WebSocket(f.url);
    const second = new WebSocket(f.url);
    await Promise.all([nextMessage(first), nextMessage(second)]);

    const correlated = nextMessage(first);
    const broadcast = nextMessage(second);
    first.send(JSON.stringify({
      type: "job.create", requestId: "create", name: "Job", workspaceId: workspace.id,
      prompt: "Do work", schedule: { kind: "daily", localTime: "07:00", timeZone: "UTC" },
      enabled: true,
    }));
    await expect(correlated).resolves.toEqual({ type: "jobs", requestId: "create", jobs: [job] });
    await expect(broadcast).resolves.toEqual({ type: "jobs", jobs: [job] });

    const accepted = nextMessage(first);
    first.send(JSON.stringify({ type: "job.run", requestId: "run", jobId: job.id }));
    await expect(accepted).resolves.toEqual({ type: "job.run.state", requestId: "run", run: queued });
    first.close();
    await vi.waitFor(() => expect(f.server.webSocketServer.clients.size).toBe(1));
    expect(f.detachedExecutions()).toBe(1);

    const updated = { ...queued, status: "running" as const, startedAt: 2, revision: 1, updatedAt: 2, preStdout: "private output" };
    const revision = nextMessage(second);
    f.emit({ type: "job.run.updated", run: summaryOnly(updated) });
    await expect(revision).resolves.toEqual({
      type: "job.run.updated", jobId: job.id, runId: queued.id, revision: 1,
      run: summaryOnly(updated),
    });
    expect(JSON.stringify(await revision.catch(() => undefined))).not.toContain("private output");
    second.close();
  });

  it("rejects unknown command fields and workspace deletion while referenced", async () => {
    const f = await start();
    const socket = new WebSocket(f.url);
    await nextMessage(socket);
    f.jobs.create({
      name: job.name, workspaceId: workspace.id, prompt: job.prompt,
      schedule: { kind: "daily", localTime: "07:00", timeZone: "UTC" }, enabled: true,
    });

    const invalid = nextMessage(socket);
    socket.send(JSON.stringify({ type: "job.list", requestId: "bad", policy: {} }));
    await expect(invalid).resolves.toEqual({
      type: "error", requestId: "bad", code: "invalid_command", message: "The command is invalid.",
    });

    const blocked = nextMessage(socket);
    socket.send(JSON.stringify({ type: "workspace.delete", requestId: "delete", workspaceId: workspace.id }));
    await expect(blocked).resolves.toMatchObject({
      type: "error", requestId: "delete", code: "workspace_busy",
    });
    expect(f.workspaces.delete).not.toHaveBeenCalled();
    socket.close();
  });
});
