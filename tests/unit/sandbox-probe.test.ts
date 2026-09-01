import { describe, expect, it } from "vitest";

import {
  SANDBOX_EXPECTED_ENVIRONMENT_WITH_PWD,
  type SandboxWorkerArtifact,
} from "../../src/server/sandbox/bwrap.js";
import {
  validateSandboxWorkerReady,
  type SandboxProbeContext,
} from "../../src/server/sandbox/probe.js";

const artifact: SandboxWorkerArtifact = {
  source: Buffer.from("worker"), sha256: "a".repeat(64), version: "1",
};
const context: SandboxProbeContext = {
  nonce: "nonce-nonce-nonce-nonce",
  artifact,
  parentNamespaces: {
    user: "user-parent", mnt: "mnt-parent", pid: "pid-parent",
    ipc: "ipc-parent", uts: "uts-parent", net: "net-parent",
  },
  expectedRootEntries: ["app", "bin", "dev", "etc", "home", "proc", "tmp", "usr", "var", "workspace"],
  expectedEnvironment: SANDBOX_EXPECTED_ENVIRONMENT_WITH_PWD,
  workspaceDevice: "1",
  workspaceInode: "2",
  hiddenPathCount: 3,
  mounts: { "/opt/tool": { dev: "3", ino: "4" } },
};

function ready(): Record<string, unknown> {
  return {
    type: "ready",
    protocol: 1,
    nonce: context.nonce,
    probe: {
      namespaces: {
        user: "user-child", mnt: "mnt-child", pid: "pid-child",
        ipc: "ipc-child", uts: "uts-child", net: "net-child",
      },
      hostname: "chatwca-sandbox",
      capEff: "0000000000000000",
      noNewPrivs: "1",
      environment: SANDBOX_EXPECTED_ENVIRONMENT_WITH_PWD,
      rootEntries: [...context.expectedRootEntries].sort(),
      devEntries: [
        "core", "fd", "full", "null", "ptmx", "pts", "random", "shm",
        "stderr", "stdin", "stdout", "tty", "urandom", "zero",
      ],
      etcEntries: ["group", "hosts", "nsswitch.conf", "passwd"],
      hiddenPaths: [true, true, true],
      chatwcaMask: { hostSessionHidden: true, guestWriteVisible: true },
      workspace: { dev: "1", ino: "2", marker: "marker" },
      mountIdentities: { "/opt/tool": { dev: "3", ino: "4", readOnly: true } },
      artifact: { sha256: artifact.sha256, version: artifact.version },
      commands: {
        node: { status: 0, stdout: "v22.19.0" },
        bash: { status: 0, stdout: "bubblewrap-bash" },
        rg: { status: 0, stdout: "ripgrep 14.0.0" },
      },
      network: {
        ipv4: { connected: false }, ipv6: { connected: false },
        loopback4: { connected: false }, loopback6: { connected: false },
        dns: { resolved: false },
      },
    },
  };
}

function probe(value: Record<string, unknown>): Record<string, unknown> {
  return value.probe as Record<string, unknown>;
}

describe("sandbox per-worker probe validation", () => {
  it("accepts a nonce/artifact-bound fully isolated handshake", () => {
    expect(() => validateSandboxWorkerReady(ready(), context)).not.toThrow();
  });

  it.each([
    ["nonce", (value: Record<string, unknown>) => { value.nonce = "spoofed"; }],
    ["namespace", (value: Record<string, unknown>) => {
      (probe(value).namespaces as Record<string, unknown>).net = "net-parent";
    }],
    ["capabilities", (value: Record<string, unknown>) => { probe(value).capEff = "1"; }],
    ["no-new-privileges", (value: Record<string, unknown>) => { probe(value).noNewPrivs = "0"; }],
    ["environment", (value: Record<string, unknown>) => {
      probe(value).environment = { ...SANDBOX_EXPECTED_ENVIRONMENT_WITH_PWD, SECRET: "leak" };
    }],
    ["root", (value: Record<string, unknown>) => { probe(value).rootEntries = ["usr", "workspace", "host"]; }],
    ["protected path", (value: Record<string, unknown>) => { probe(value).hiddenPaths = [true, false, true]; }],
    ["workspace mount", (value: Record<string, unknown>) => {
      probe(value).workspace = { dev: "9", ino: "2", marker: "marker" };
    }],
    ["read-only mount", (value: Record<string, unknown>) => {
      probe(value).mountIdentities = { "/opt/tool": { dev: "3", ino: "4", readOnly: false } };
    }],
    ["artifact hash", (value: Record<string, unknown>) => {
      probe(value).artifact = { sha256: "b".repeat(64), version: "1" };
    }],
    ["network", (value: Record<string, unknown>) => {
      (probe(value).network as Record<string, unknown>).loopback4 = { connected: true };
    }],
  ])("fails closed when %s differs", (_name, mutate) => {
    const value = ready();
    mutate(value);
    expect(() => validateSandboxWorkerReady(value, context)).toThrow();
  });
});
