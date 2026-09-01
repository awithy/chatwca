import { spawn as spawnProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import type { BwrapLaunchSpecification, SandboxWorkerArtifact } from "../../src/server/sandbox/bwrap.js";
import {
  SandboxFrameDecoder,
  encodeSandboxFrame,
  isParentFrame,
  type ParentFrame,
  type WorkerFrame,
} from "../../src/server/sandbox/protocol.js";
import type { SandboxProbeContext } from "../../src/server/sandbox/probe.js";
import {
  SandboxWorkerClient,
  SandboxWorkerOperationError,
  type SandboxSpawn,
} from "../../src/server/sandbox/worker-client.js";

const artifact: SandboxWorkerArtifact = { source: Buffer.from("worker"), sha256: "a".repeat(64), version: "1" };
const context: SandboxProbeContext = {
  nonce: "nonce-nonce-nonce-nonce", artifact,
  parentNamespaces: { user: "pu", mnt: "pm", pid: "pp", ipc: "pi", uts: "pt", net: "pn" },
  expectedRootEntries: ["app", "dev", "etc", "home", "proc", "tmp", "usr", "var", "workspace"],
  expectedEnvironment: { HOME: "/home/sandbox", TMPDIR: "/tmp", PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", TERM: "dumb", NO_COLOR: "1", CI: "1", USER: "sandbox", LOGNAME: "sandbox", SHELL: "/bin/bash", PWD: "/workspace" },
  workspaceDevice: "1", workspaceInode: "2", hiddenPathCount: 1, mounts: {},
};
const specification: BwrapLaunchSpecification = {
  executable: "/usr/bin/bwrap", argv: [],
  dataBindings: [{ fd: 3, destination: "/app/worker.mjs", payload: Buffer.from("worker") }],
  requestFd: 8, responseFd: 9, expectedRootEntries: context.expectedRootEntries,
};

function ready(nonce = context.nonce): WorkerFrame {
  return {
    type: "ready", protocol: 1, nonce,
    probe: {
      namespaces: { user: "cu", mnt: "cm", pid: "cp", ipc: "ci", uts: "ct", net: "cn" },
      hostname: "chatwca-sandbox", capEff: "0000000000000000", noNewPrivs: "1",
      environment: context.expectedEnvironment, rootEntries: [...context.expectedRootEntries],
      devEntries: ["core", "fd", "full", "null", "ptmx", "pts", "random", "shm", "stderr", "stdin", "stdout", "tty", "urandom", "zero"],
      etcEntries: ["group", "hosts", "nsswitch.conf", "passwd"], hiddenPaths: [true],
      chatwcaMask: { hostSessionHidden: true, guestWriteVisible: true },
      workspace: { dev: "1", ino: "2", marker: "marker" }, mountIdentities: {},
      artifact: { sha256: artifact.sha256, version: "1" },
      commands: { node: { status: 0, stdout: "v22.19.0" }, bash: { status: 0, stdout: "bubblewrap-bash" }, rg: { status: 0, stdout: "ripgrep 14.0.0" } },
      network: { ipv4: { connected: false }, ipv6: { connected: false }, loopback4: { connected: false }, loopback6: { connected: false }, dns: { resolved: false } },
    },
  };
}

class FakeChild extends EventEmitter {
  readonly pid = undefined;
  readonly stdio = Array.from({ length: 10 }, () => new PassThrough());
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly received: ParentFrame[] = [];
  readonly decoder = new SandboxFrameDecoder(isParentFrame);
  onFrame?: (frame: ParentFrame) => void;

  constructor(autoReady = true) {
    super();
    (this.stdio[8] as PassThrough).on("data", (chunk: Buffer) => {
      for (const value of this.decoder.push(chunk)) {
        const frame = value as ParentFrame; this.received.push(frame);
        if (frame.type === "hello" && autoReady) this.send(ready(frame.nonce));
        this.onFrame?.(frame);
      }
    });
  }
  send(frame: WorkerFrame): void { (this.stdio[9] as PassThrough).write(encodeSandboxFrame(frame)); }
  raw(data: Buffer): void { (this.stdio[9] as PassThrough).write(data); }
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    this.signalCode = signal;
    queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }
}

async function start(child: FakeChild, fatal = vi.fn()) {
  const spawn: SandboxSpawn = () => child;
  return {
    client: await SandboxWorkerClient.start({ specification, probeContext: context, hiddenPaths: ["/hidden"], startTimeoutMs: 100, onFatal: fatal, spawn }),
    fatal,
  };
}

async function eventually(assertion: () => void): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    try { assertion(); return; } catch { await new Promise((resolve) => setTimeout(resolve, 2)); }
  }
  assertion();
}

describe("SandboxWorkerClient hostile transport", () => {
  it("correlates typed calls, chunks reads, and preserves streamed output ordering", async () => {
    const child = new FakeChild();
    child.onFrame = (frame) => {
      if (frame.type !== "request") return;
      if (frame.operation === "health") child.send({ type: "response", id: frame.id, result: { healthy: true } });
      if (frame.operation === "readFile") {
        child.send({ type: "response.chunk", id: frame.id, sequence: 0, encoding: "base64", data: Buffer.from("hello").toString("base64") });
        child.send({ type: "response.end", id: frame.id, bytes: 5, sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", result: { mimeType: "text/plain" } });
      }
      if (frame.operation === "exec") {
        child.send({ type: "output", id: frame.id, sequence: 0, stream: "stdout", data: "one" });
        child.send({ type: "output", id: frame.id, sequence: 1, stream: "stderr", data: "two" });
        child.send({ type: "response", id: frame.id, result: { exitCode: 0, signal: null, timedOut: false, fullOutputPath: null } });
      }
    };
    const { client } = await start(child);
    expect(await client.health()).toEqual({ healthy: true });
    expect((await client.readFile({ path: "x", maxBytes: 10, detectMime: true })).data.toString()).toBe("hello");
    const output: string[] = [];
    await client.exec({ command: "true", timeoutMs: 100 }, { onOutput: async ({ data }) => { await Promise.resolve(); output.push(data); } });
    expect(output).toEqual(["one", "two"]);
    await client.close();
    expect(child.stdio.every((stream) => stream.destroyed)).toBe(true);
  });

  it("rejects invalid and oversized typed requests without writing to or killing the worker", async () => {
    const child = new FakeChild(); const fatal = vi.fn(); const seen: ParentFrame[] = [];
    child.onFrame = (frame) => { seen.push(frame); };
    const { client } = await start(child, fatal);
    await expect(client.readFile({ path: "", maxBytes: 10, detectMime: false }))
      .rejects.toEqual(new SandboxWorkerOperationError("invalid_arguments"));
    await expect(client.editFile({ path: "x", edits: [{ oldText: "x".repeat(1024 * 1024), newText: "y" }] }))
      .rejects.toEqual(new SandboxWorkerOperationError("output_limit"));
    await expect(client.writeFile("x", Buffer.alloc(16 * 1024 * 1024 + 1)))
      .rejects.toEqual(new SandboxWorkerOperationError("output_limit"));
    expect(seen.filter((frame) => frame.type === "request")).toEqual([]);
    expect(fatal).not.toHaveBeenCalled();
    await client.close();
  });

  it("treats spoofed IDs and duplicate terminals as fatal exactly once", async () => {
    for (const mode of ["spoof", "duplicate"] as const) {
      const child = new FakeChild(); const fatal = vi.fn();
      child.onFrame = (frame) => {
        if (frame.type !== "request") return;
        if (mode === "spoof") child.send({ type: "error", id: "parent_did_not_create", code: "operation_failed" });
        else {
          child.send({ type: "response", id: frame.id, result: { healthy: true } });
          child.send({ type: "response", id: frame.id, result: { healthy: true } });
        }
      };
      const { client } = await start(child, fatal);
      const call = client.health();
      await expect(call).rejects.toMatchObject({ code: "sandbox_worker_failed" });
      await eventually(() => expect(fatal).toHaveBeenCalledTimes(1));
      await client.close();
      expect(fatal).toHaveBeenCalledTimes(1);
    }
  });

  it("propagates cancellation without converting a healthy operation error into fatal", async () => {
    const child = new FakeChild(); const fatal = vi.fn(); let requestId = "";
    child.onFrame = (frame) => {
      if (frame.type === "request") requestId = frame.id;
      if (frame.type === "cancel") child.send({ type: "error", id: frame.id, code: "cancelled" });
    };
    const { client } = await start(child, fatal);
    const controller = new AbortController();
    const call = client.exec({ command: "sleep", timeoutMs: 1000 }, { signal: controller.signal });
    await eventually(() => expect(requestId).not.toBe(""));
    controller.abort(new Error("stop"));
    await expect(call).rejects.toThrow("stop");
    await eventually(() => expect(client.activeOperations).toBe(0));
    expect(fatal).not.toHaveBeenCalled();
    await client.close();
  });

  it("honors request-pipe backpressure from a slow worker reader", async () => {
    const child = new FakeChild(false); const decoder = new SandboxFrameDecoder(isParentFrame);
    (child.stdio[8] as PassThrough).removeAllListeners();
    const slow = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback) {
        setTimeout(() => {
          for (const value of decoder.push(chunk)) {
            const frame = value as ParentFrame;
            if (frame.type === "hello") child.send(ready(frame.nonce));
            if (frame.type === "request") child.send({ type: "response", id: frame.id, result: { healthy: true } });
          }
          callback();
        }, 5);
      },
    });
    (child.stdio as unknown as Array<NodeJS.ReadableStream | NodeJS.WritableStream | null>)[8] = slow;
    const { client } = await start(child);
    expect(await client.health()).toEqual({ healthy: true });
    await client.close();
  });

  it("enforces eight active operations and correlates out-of-order request races", async () => {
    const child = new FakeChild(); const fatal = vi.fn(); const requests: string[] = [];
    child.onFrame = (frame) => {
      if (frame.type !== "request") return;
      requests.push(frame.id);
      if (requests.length === 8) {
        for (const id of [...requests].reverse()) child.send({ type: "response", id, result: { healthy: true } });
      }
    };
    const { client } = await start(child, fatal);
    const calls = Array.from({ length: 8 }, () => client.health());
    await expect(client.health()).rejects.toMatchObject({ code: "operation_failed" });
    await expect(Promise.all(calls)).resolves.toEqual(Array.from({ length: 8 }, () => ({ healthy: true })));
    expect(fatal).not.toHaveBeenCalled();
    await client.close();
  });

  it("fails the correlated call when an output consumer throws before its terminal", async () => {
    const child = new FakeChild(); const fatal = vi.fn();
    child.onFrame = (frame) => {
      if (frame.type !== "request" || frame.operation !== "exec") return;
      child.send({ type: "output", id: frame.id, sequence: 0, stream: "stdout", data: "output" });
      child.send({ type: "response", id: frame.id, result: { exitCode: 0, signal: null, timedOut: false, fullOutputPath: null } });
    };
    const { client } = await start(child, fatal);
    await expect(client.exec({ command: "true", timeoutMs: 100 }, { onOutput: () => { throw new Error("consumer failed"); } }))
      .rejects.toMatchObject({ code: "sandbox_worker_failed" });
    expect(fatal).toHaveBeenCalledTimes(1);
    await client.close();
  });

  it("kills a worker whose output outruns a deliberately slow parent consumer", async () => {
    const child = new FakeChild(); const fatal = vi.fn();
    child.onFrame = (frame) => {
      if (frame.type !== "request" || frame.operation !== "exec") return;
      for (let sequence = 0; sequence < 7; sequence += 1) {
        child.send({ type: "output", id: frame.id, sequence, stream: "stdout", data: "x".repeat(700_000) });
      }
    };
    const { client } = await start(child, fatal);
    const never = new Promise<void>(() => undefined);
    await expect(client.exec({ command: "flood", timeoutMs: 100 }, { onOutput: () => never }))
      .rejects.toMatchObject({ code: "sandbox_worker_failed" });
    await eventually(() => expect(fatal).toHaveBeenCalledTimes(1));
    await client.close();
  });

  it("bounds private stderr and fails on malformed lengths, schema, sequence, and hash", async () => {
    const attacks = [
      (child: FakeChild) => { const prefix = Buffer.alloc(4); prefix.writeUInt32BE(0); child.raw(prefix); },
      (child: FakeChild) => child.raw(encodeSandboxFrame({ type: "shutdown.complete" })),
      (child: FakeChild, id: string) => child.send({ type: "response.chunk", id, sequence: 1, encoding: "base64", data: "" }),
      (child: FakeChild, id: string) => {
        child.send({ type: "response.chunk", id, sequence: 0, encoding: "base64", data: "aA==" });
        child.send({ type: "response.end", id, bytes: 1, sha256: "0".repeat(64), result: { mimeType: null } });
      },
    ];
    for (const [index, attack] of attacks.entries()) {
      const child = new FakeChild(); const fatal = vi.fn(); let id = "";
      child.onFrame = (frame) => { if (frame.type === "request") { id = frame.id; attack(child, id); } };
      const { client } = await start(child, fatal);
      (child.stdio[2] as PassThrough).write("x".repeat(100_000));
      const call = index < 2 ? client.health() : client.readFile({ path: "x", maxBytes: 10, detectMime: false });
      await expect(call).rejects.toMatchObject({ code: "sandbox_worker_failed" });
      expect(client.diagnostic.length).toBeLessThanOrEqual(16 * 1024);
      await eventually(() => expect(fatal).toHaveBeenCalledTimes(1));
      await client.close();
    }
  });

  it("fails closed on timeout, bad nonce, process error, and exit throughout handshake", async () => {
    const cases = [
      (child: FakeChild) => undefined,
      (child: FakeChild) => child.send(ready("wrong-wrong-wrong-wrong")),
      (child: FakeChild) => queueMicrotask(() => child.emit("error", new Error("spawn failed"))),
      (child: FakeChild) => child.kill("SIGKILL"),
    ];
    for (const trigger of cases) {
      const child = new FakeChild(false); const fatal = vi.fn(); trigger(child);
      const spawn: SandboxSpawn = () => child;
      await expect(SandboxWorkerClient.start({ specification, probeContext: context, hiddenPaths: ["/hidden"], startTimeoutMs: 15, onFatal: fatal, spawn })).rejects.toMatchObject({ code: "sandbox_worker_start_failed" });
      expect(fatal).toHaveBeenCalledTimes(1);
      expect(child.stdio.every((stream) => stream.destroyed)).toBe(true);
    }

    const fatal = vi.fn();
    await expect(SandboxWorkerClient.start({
      specification, probeContext: context, hiddenPaths: ["/hidden"], startTimeoutMs: 15,
      onFatal: fatal, spawn: () => { throw new Error("spawn rejected"); },
    })).rejects.toMatchObject({ code: "sandbox_worker_start_failed" });
    expect(fatal).toHaveBeenCalledTimes(1);
  });

  it("fails closed against the standalone hostile worker fixture", async () => {
    for (const mode of ["invalid-length", "partial-prefix", "stderr-flood", "unsolicited", "coalesced-terminals"]) {
      const fatal = vi.fn();
      const hostile = fileURLToPath(new URL("../fixtures/sandbox/hostile-worker.mjs", import.meta.url));
      const spawn: SandboxSpawn = () => spawnProcess(process.execPath, [hostile, mode], {
        detached: true, stdio: Array.from({ length: 10 }, (_, fd) => fd < 2 ? "ignore" : "pipe"),
      });
      await expect(SandboxWorkerClient.start({
        specification: { ...specification, dataBindings: [] }, probeContext: context,
        hiddenPaths: ["/hidden"], startTimeoutMs: 200, onFatal: fatal, spawn,
      })).rejects.toMatchObject({ code: "sandbox_worker_start_failed" });
      expect(fatal).toHaveBeenCalledTimes(1);
    }
  });

  it("handles simultaneous graceful shutdown and exit without fatal notification", async () => {
    const child = new FakeChild(); const fatal = vi.fn();
    child.onFrame = (frame) => {
      if (frame.type === "shutdown") {
        child.send({ type: "shutdown.complete" }); child.kill("SIGTERM");
      }
    };
    const { client } = await start(child, fatal);
    await Promise.all([client.close(), client.close()]);
    expect(fatal).not.toHaveBeenCalled();
    expect(child.stdio.every((stream) => stream.destroyed)).toBe(true);
  });
});
