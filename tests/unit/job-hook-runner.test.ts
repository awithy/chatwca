import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import {
  JobHookRunner,
  JOB_HOOK_SAFE_PATH,
  buildHookEnvironment,
  type JobHookChild,
  type JobHookRunInput,
} from "../../src/server/job-hook-runner.js";
import { ERROR_CODES } from "../../src/shared/errors.js";

class FakeChild extends EventEmitter {
  readonly pid: number;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  constructor(pid = 4321) {
    super();
    this.pid = pid;
  }

  close(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("close", code, signal);
  }
}

const baseInput: JobHookRunInput = {
  canonicalScriptPath: "/trusted/hook.sh",
  jobId: "job-1",
  jobName: "Daily report",
  runId: "run-1",
  trigger: "scheduled",
  scheduledFor: Date.UTC(2026, 0, 2, 3, 4, 5),
  workspaceId: "workspace-1",
  workspacePath: "/srv/workspace",
  conversationId: null,
  phase: "pre-hook",
};

function fakeRunner(
  child: FakeChild,
  overrides: Partial<ConstructorParameters<typeof JobHookRunner>[0]> = {},
) {
  const kills: Array<[number, NodeJS.Signals]> = [];
  let launch: { executable: string; argv: readonly string[]; options: SpawnOptions } | undefined;
  const runner = new JobHookRunner({
    config: { hookTimeoutMs: 1_000, hookMaxOutputBytes: 1_024 },
    environment: { HOME: "/safe/home", LANG: "C.UTF-8" },
    terminationGraceMs: 10,
    spawn: (executable, argv, options) => {
      launch = { executable, argv, options };
      return child as unknown as JobHookChild;
    },
    killProcessGroup: (pid, signal) => { kills.push([pid, signal]); },
    ...overrides,
  });
  return { runner, kills, launch: () => launch };
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const target of temporaryDirectories.splice(0)) rmSync(target, { recursive: true, force: true });
});

describe("JobHookRunner", () => {
  it("uses fixed Bash argv/cwd and a sanitized allowlist environment", async () => {
    const child = new FakeChild();
    const fixture = fakeRunner(child);
    const pending = fixture.runner.run(baseInput);
    child.stdout.write("hello");
    child.stderr.write("warning");
    child.close(0);

    await expect(pending).resolves.toEqual({
      succeeded: true,
      exitCode: 0,
      signal: null,
      stdout: "hello",
      stderr: "warning",
      errorCode: null,
    });
    expect(fixture.launch()).toEqual({
      executable: "/usr/bin/bash",
      argv: ["--", "/trusted/hook.sh"],
      options: {
        cwd: "/srv/workspace",
        env: {
          HOME: "/safe/home",
          LANG: "C.UTF-8",
          PATH: JOB_HOOK_SAFE_PATH,
          CHATWCA_JOB_ID: "job-1",
          CHATWCA_JOB_NAME: "Daily report",
          CHATWCA_RUN_ID: "run-1",
          CHATWCA_RUN_TRIGGER: "scheduled",
          CHATWCA_SCHEDULED_FOR: "2026-01-02T03:04:05.000Z",
          CHATWCA_WORKSPACE_ID: "workspace-1",
          CHATWCA_WORKSPACE: "/srv/workspace",
          CHATWCA_CONVERSATION_ID: "",
          CHATWCA_RUN_PHASE: "pre-hook",
          CHATWCA_RUN_STATUS: "running",
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    });
    expect(fixture.launch()?.options.env).not.toHaveProperty("NODE_OPTIONS");
  });

  it("builds post-hook metadata without prompt, script, credentials, or arbitrary values", () => {
    const environment = buildHookEnvironment({
      ...baseInput,
      phase: "post-hook",
      conversationId: "conversation-1",
    }, { HOME: "/home/service", LANG: "en_US.UTF-8" });
    expect(environment).toMatchObject({
      CHATWCA_CONVERSATION_ID: "conversation-1",
      CHATWCA_RUN_PHASE: "post-hook",
      CHATWCA_RUN_STATUS: "succeeded",
    });
    expect(Object.keys(environment).sort()).toEqual([
      "CHATWCA_CONVERSATION_ID", "CHATWCA_JOB_ID", "CHATWCA_JOB_NAME",
      "CHATWCA_RUN_ID", "CHATWCA_RUN_PHASE", "CHATWCA_RUN_STATUS",
      "CHATWCA_RUN_TRIGGER", "CHATWCA_SCHEDULED_FOR", "CHATWCA_WORKSPACE",
      "CHATWCA_WORKSPACE_ID", "HOME", "LANG", "PATH",
    ].sort());
  });

  it("enforces one aggregate output bound and decodes retained UTF-8 only once", async () => {
    const child = new FakeChild();
    const fixture = fakeRunner(child, {
      config: { hookTimeoutMs: 1_000, hookMaxOutputBytes: 4 },
    });
    const pending = fixture.runner.run(baseInput);
    child.stdout.write(Buffer.from([0xe2, 0x82]));
    child.stderr.write("A");
    child.stdout.write(Buffer.from([0xac, 0x58]));

    const result = await pending;
    expect(result).toMatchObject({
      succeeded: false,
      stdout: "€",
      stderr: "A",
      errorCode: ERROR_CODES.JOB_HOOK_OUTPUT_LIMIT,
    });
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBe(4);
    expect(fixture.kills).toEqual([[4321, "SIGTERM"], [4321, "SIGKILL"]]);
    child.close(null, "SIGKILL");
    expect(fixture.kills).toHaveLength(2);
  });

  it("classifies nonzero exits, signals, and spawn failures by hook phase", async () => {
    for (const [phase, expected] of [
      ["pre-hook", ERROR_CODES.JOB_PRE_RUN_FAILED],
      ["post-hook", ERROR_CODES.JOB_POST_RUN_FAILED],
    ] as const) {
      const nonzero = new FakeChild();
      const first = fakeRunner(nonzero).runner.run({ ...baseInput, phase });
      nonzero.close(7);
      await expect(first).resolves.toMatchObject({ exitCode: 7, errorCode: expected });

      const signaled = new FakeChild();
      const second = fakeRunner(signaled).runner.run({ ...baseInput, phase });
      signaled.close(null, "SIGUSR1");
      await expect(second).resolves.toMatchObject({ signal: "SIGUSR1", errorCode: expected });
    }

    const runner = new JobHookRunner({
      config: { hookTimeoutMs: 100, hookMaxOutputBytes: 100 },
      spawn: () => { throw new Error("private spawn failure"); },
    });
    await expect(runner.run(baseInput)).resolves.toMatchObject({
      errorCode: ERROR_CODES.JOB_PRE_RUN_FAILED,
      stdout: "",
      stderr: "",
    });
  });

  it("uses TERM then KILL for timeout and abort with idempotent cleanup", async () => {
    const timeoutChild = new FakeChild();
    const timeoutFixture = fakeRunner(timeoutChild, {
      config: { hookTimeoutMs: 5, hookMaxOutputBytes: 100 },
    });
    await expect(timeoutFixture.runner.run(baseInput)).resolves.toMatchObject({
      errorCode: ERROR_CODES.JOB_HOOK_TIMEOUT,
    });
    expect(timeoutFixture.kills).toEqual([[4321, "SIGTERM"], [4321, "SIGKILL"]]);

    const abortChild = new FakeChild(5000);
    const abortFixture = fakeRunner(abortChild);
    const controller = new AbortController();
    const aborted = abortFixture.runner.run({ ...baseInput, signal: controller.signal });
    controller.abort();
    controller.abort();
    await expect(aborted).resolves.toMatchObject({ errorCode: ERROR_CODES.JOB_ABORTED });
    expect(abortFixture.kills).toEqual([[5000, "SIGTERM"], [5000, "SIGKILL"]]);
  });

  it("closes admission synchronously and terminates every active group on shutdown", async () => {
    const child = new FakeChild();
    const fixture = fakeRunner(child);
    const pending = fixture.runner.run(baseInput);
    expect(fixture.runner.activeCount).toBe(1);
    fixture.runner.beginShutdown();
    expect(fixture.runner.closed).toBe(true);
    expect(fixture.kills[0]).toEqual([4321, "SIGTERM"]);
    await expect(pending).resolves.toMatchObject({ errorCode: ERROR_CODES.JOB_INTERRUPTED });
    expect(fixture.runner.activeCount).toBe(0);
    await expect(fixture.runner.run(baseInput)).resolves.toMatchObject({
      errorCode: ERROR_CODES.JOB_INTERRUPTED,
    });
    fixture.runner.beginShutdown();
    expect(fixture.kills).toHaveLength(2);
  });

  it.runIf(process.platform === "linux")("kills a real descendant process group on timeout", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "chatwca-hook-runner-"));
    temporaryDirectories.push(workspace);
    const script = path.join(workspace, "tree.sh");
    writeFileSync(script, "trap '' TERM\n( trap '' TERM; sleep 30 ) &\necho $!\nwait\n");
    let groupPid: number | undefined;
    const runner = new JobHookRunner({
      config: { hookTimeoutMs: 100, hookMaxOutputBytes: 1_024 },
      terminationGraceMs: 50,
      spawn: (executable, argv, options) => {
        const child = nodeSpawn(executable, argv, options);
        groupPid = child.pid;
        return child as unknown as JobHookChild;
      },
    });

    const result = await runner.run({
      ...baseInput,
      canonicalScriptPath: script,
      workspacePath: workspace,
    });
    expect(result.errorCode).toBe(ERROR_CODES.JOB_HOOK_TIMEOUT);
    expect(Number(result.stdout.trim())).toBeGreaterThan(0);
    expect(groupPid).toBeTypeOf("number");

    let alive = true;
    for (let attempt = 0; attempt < 20 && alive; attempt += 1) {
      try { process.kill(-groupPid!, 0); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
      }
      if (alive) await delay(10);
    }
    expect(alive).toBe(false);
  });
});
