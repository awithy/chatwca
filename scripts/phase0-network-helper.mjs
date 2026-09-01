#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdtemp, readFile, readdir, readlink, rm, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";

const TIMEOUT_MS = 15_000;
const NAMESPACES = ["user", "mnt", "pid", "ipc", "uts", "net"];
const EXPECTED_ENVIRONMENT = {
  HOME: "/tmp",
  TMPDIR: "/tmp",
  PATH: "/usr/bin:/bin",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  TERM: "dumb",
  NO_COLOR: "1",
  CI: "1",
  USER: "sandbox",
  LOGNAME: "sandbox",
  SHELL: "/bin/bash",
  PWD: "/tmp",
  PHASE0_SECCOMP_CHECKED: "1",
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function waitForExit(child, timeoutMs = TIMEOUT_MS) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`process ${child.pid} did not exit`)), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function lineReader(stream) {
  let buffer = "";
  const values = [];
  const waiters = [];
  const consume = () => {
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        value = { type: "invalid", line };
      }
      values.push(value);
      for (const waiter of [...waiters]) {
        if (waiter.predicate(value)) {
          waiter.resolve(value);
          waiters.splice(waiters.indexOf(waiter), 1);
        }
      }
    }
  };
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer += chunk;
    consume();
  });
  return {
    waitFor(predicate, timeoutMs = TIMEOUT_MS) {
      const existing = values.find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject };
        waiters.push(waiter);
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error("timed out waiting for helper output"));
        }, timeoutMs);
        waiter.resolve = (value) => {
          clearTimeout(timer);
          resolve(value);
        };
      });
    },
  };
}

function collectDiagnostics(stream) {
  let output = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => { output = (output + chunk).slice(-16_384); });
  return () => output;
}

async function createEchoServer(socketPath) {
  const server = net.createServer((socket) => {
    socket.on("data", (chunk) => socket.write(chunk));
    socket.on("end", () => socket.end());
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return server;
}

function outerArguments({ bwrap, helper, worker, httpSocket, socksSocket }) {
  return [
    "--phase0-outer",
    "--bwrap", bwrap,
    "--worker", worker,
    "--http-socket", httpSocket,
    "--socks-socket", socksSocket,
    "--token", randomBytes(32).toString("hex"),
  ];
}

function spawnOuter(helper, argumentsList) {
  const child = spawn(helper, argumentsList, {
    detached: true,
    env: {},
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { child, lines: lineReader(child.stdout), diagnostics: collectDiagnostics(child.stderr) };
}

async function processState(pid) {
  try {
    const contents = await readFile(`/proc/${pid}/status`, "utf8");
    return contents.match(/^State:\s+(\S+)/m)?.[1] ?? "unknown";
  } catch {
    return "missing";
  }
}

async function processInactive(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await processState(pid);
    if (state === "missing" || state === "Z" || state === "X") return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

async function listProcessTree(rootPid) {
  const entries = await readdir("/proc", { withFileTypes: true });
  const parents = new Map();
  await Promise.all(entries.filter((entry) => /^\d+$/.test(entry.name)).map(async (entry) => {
    try {
      const contents = await readFile(`/proc/${entry.name}/status`, "utf8");
      const parent = Number(contents.match(/^PPid:\s+(\d+)$/m)?.[1]);
      if (Number.isInteger(parent)) parents.set(Number(entry.name), parent);
    } catch {
      // Processes may exit while /proc is scanned.
    }
  }));
  const tree = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parent] of parents) {
      if (tree.has(parent) && !tree.has(pid)) {
        tree.add(pid);
        changed = true;
      }
    }
  }
  return [...tree];
}

function validateReady(processes, ready, parentNamespaces) {
  assert(processes.environmentCount === 0, "outer helper inherited an environment");
  for (const namespace of NAMESPACES) {
    assert(ready.namespaces[namespace] !== parentNamespaces[namespace], `${namespace} namespace was shared`);
  }
  for (const name of ["capInh", "capPrm", "capEff", "capBnd", "capAmb"]) {
    assert(/^0+$/.test(ready.security[name]), `${name} was not empty: ${ready.security[name]}`);
  }
  assert(ready.security.noNewPrivs === "1", "NoNewPrivs was not enabled");
  assert(ready.security.seccomp === "2", "seccomp filter mode was not active");
  assert(ready.security.nativeChecks === "1", "native seccomp checks did not run");
  assert(ready.security.unixSocket.denied === true && ready.security.unixSocket.code === "EPERM", "AF_UNIX socket was not denied with EPERM");

  const expectedEnvironment = {
    ...EXPECTED_ENVIRONMENT,
    PHASE0_HTTP_PORT: ready.environment.PHASE0_HTTP_PORT,
    PHASE0_SOCKS_PORT: ready.environment.PHASE0_SOCKS_PORT,
  };
  assert(
    Object.keys(ready.environment).sort().join("\0") === Object.keys(expectedEnvironment).sort().join("\0")
      && Object.entries(expectedEnvironment).every(([name, value]) => ready.environment[name] === value),
    `worker environment was not closed: ${JSON.stringify(ready.environment)}`,
  );
  assert(ready.artifact.helperMode === 0o500, `helper artifact mode was ${ready.artifact.helperMode.toString(8)}`);
  assert(ready.artifact.helperWriteDenied === true, "helper artifact was writable in the guest");
  assert(ready.artifact.workerMode === 0o400, `worker artifact mode was ${ready.artifact.workerMode.toString(8)}`);
  assert(ready.artifact.workerWriteDenied === true, "worker artifact was writable in the guest");
  assert(ready.artifact.versionStatus === 0, "handed-off helper artifact was not executable");
  const version = JSON.parse(ready.artifact.version);
  assert(version.stage === "phase0" && version.protocol === 0, "helper artifact version was unexpected");
  assert(ready.bridges.http === "phase0-http", "HTTP listener did not cross its fixed bridge");
  assert(ready.bridges.socks === "phase0-socks", "SOCKS listener did not cross its fixed bridge");
  assert(Object.values(ready.blockedNetwork).every((blocked) => blocked === true), "direct network or DNS unexpectedly succeeded");
  assert(ready.unexpectedDescriptors.length === 0, `worker inherited descriptors: ${JSON.stringify(ready.unexpectedDescriptors)}`);
}

async function assertTreeInactive(pids, label) {
  const inactive = await Promise.all(pids.map((pid) => processInactive(pid)));
  assert(inactive.every(Boolean), `${label} left processes: ${pids.filter((_, index) => !inactive[index]).join(",")}`);
}

async function bubblewrapDeathProbe(configuration, parentNamespaces) {
  const launched = spawnOuter(configuration.helper, outerArguments(configuration));
  try {
    const processes = await launched.lines.waitFor((value) => value.type === "phase0-processes");
    const ready = await launched.lines.waitFor((value) => value.type === "phase0-ready");
    validateReady(processes, ready, parentNamespaces);
    const tree = await listProcessTree(launched.child.pid);
    assert(tree.length >= 5, `expected outer, bridges, Bubblewrap, inner/worker; got ${tree.join(",")}`);
    process.kill(processes.bwrapPid, "SIGKILL");
    await waitForExit(launched.child);
    assert(launched.child.exitCode !== 0, "outer helper accepted Bubblewrap death as success");
    await assertTreeInactive(tree, "Bubblewrap death");
    return { processCount: tree.length, diagnostics: launched.diagnostics() };
  } catch (error) {
    try { process.kill(-launched.child.pid, "SIGKILL"); } catch {}
    await waitForExit(launched.child, 2_000).catch(() => {});
    throw new Error(`${error.message}${launched.diagnostics() ? `; helper: ${launched.diagnostics().trim()}` : ""}`);
  }
}

async function driverMode() {
  const [helper, ...argumentsList] = process.argv.slice(3);
  assert(helper, "driver requires helper path");
  const child = spawn(helper, argumentsList, {
    detached: true,
    env: {},
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.once("exit", (code, signal) => process.exit(signal ? 1 : code ?? 1));
  setInterval(() => {}, 60_000);
}

async function parentDeathProbe(configuration, parentNamespaces) {
  const argumentsList = outerArguments(configuration);
  const driver = spawn(process.execPath, [new URL(import.meta.url).pathname, "--driver", configuration.helper, ...argumentsList], {
    env: {},
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = lineReader(driver.stdout);
  const diagnostics = collectDiagnostics(driver.stderr);
  let processes;
  try {
    processes = await lines.waitFor((value) => value.type === "phase0-processes");
    const ready = await lines.waitFor((value) => value.type === "phase0-ready");
    validateReady(processes, ready, parentNamespaces);
    const tree = await listProcessTree(driver.pid);
    assert(tree.includes(processes.outerPid), "driver did not own the outer helper");
    process.kill(driver.pid, "SIGKILL");
    await waitForExit(driver);
    await assertTreeInactive(tree, "Node parent death");
    return { processCount: tree.length };
  } catch (error) {
    if (processes?.outerPid) {
      try { process.kill(-processes.outerPid, "SIGKILL"); } catch {}
    }
    driver.kill("SIGKILL");
    await waitForExit(driver, 2_000).catch(() => {});
    throw new Error(`${error.message}${diagnostics() ? `; helper: ${diagnostics().trim()}` : ""}`);
  }
}

async function main() {
  if (process.argv[2] === "--driver") {
    await driverMode();
    return;
  }
  if (process.env.CHATWCA_SANDBOX_CAPABLE !== "1") {
    console.log(JSON.stringify({ result: "skip", reason: "CHATWCA_SANDBOX_CAPABLE is not 1" }));
    return;
  }
  assert(process.platform === "linux", "sandbox-capable run requires Linux");
  assert(["x64", "arm64"].includes(process.arch), `unsupported architecture ${process.arch}`);

  const helper = path.resolve("native/network-helper/target/release/chatwca-network-helper");
  const worker = path.resolve("tests/fixtures/network-helper/phase0-worker.cjs");
  const bwrap = "/usr/bin/bwrap";
  await Promise.all([
    access(helper, fsConstants.X_OK),
    access(worker, fsConstants.R_OK),
    access(bwrap, fsConstants.X_OK),
  ]);
  const helperMetadata = await stat(helper);
  assert(helperMetadata.isFile(), "Phase 0 helper is not a regular file");

  const temporary = await mkdtemp(path.join(tmpdir(), "chatwca-network-phase0-"));
  const httpSocket = path.join(temporary, "h.sock");
  const socksSocket = path.join(temporary, "s.sock");
  const httpServer = await createEchoServer(httpSocket);
  const socksServer = await createEchoServer(socksSocket);
  const parentNamespaces = Object.fromEntries(await Promise.all(NAMESPACES.map(async (name) => [
    name,
    (await readlink(`/proc/self/ns/${name}`)).toString(),
  ])));
  const configuration = { helper, worker, bwrap, httpSocket, socksSocket };
  try {
    const bubblewrap = await bubblewrapDeathProbe(configuration, parentNamespaces);
    const parent = await parentDeathProbe(configuration, parentNamespaces);
    console.log(JSON.stringify({
      result: "pass",
      stage: "phase0",
      architecture: process.arch,
      invocation: process.env.INVOCATION_ID ? "systemd" : "direct",
      artifactHandoff: "--perms 0500 --ro-bind-data",
      bubblewrapDeathProcessCount: bubblewrap.processCount,
      parentDeathProcessCount: parent.processCount,
    }, null, 2));
  } finally {
    await Promise.all([httpServer, socksServer].map((server) => new Promise((resolve) => server.close(resolve))));
    await rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`Network helper Phase 0 feasibility failed: ${error.stack || error}`);
  process.exitCode = 1;
});
