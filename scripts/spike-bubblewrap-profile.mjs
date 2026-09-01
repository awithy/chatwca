#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, readdir, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const NAMESPACES = ["user", "mnt", "pid", "ipc", "uts", "net"];
const EXPECTED_ENVIRONMENT = {
  HOME: "/home/sandbox",
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
  // Bubblewrap 0.6.1 adds this after --clearenv/--unsetenv. The worker must
  // rebuild command environments rather than forwarding process.env.
  PWD: "/workspace",
};
const EXPECTED_DEV_ENTRIES = [
  "core", "fd", "full", "null", "ptmx", "pts", "random", "shm",
  "stderr", "stdin", "stdout", "tty", "urandom", "zero",
];
const EXPECTED_ROOT_ENTRIES = [
  "app", "bin", "dev", "etc", "home", "lib", "lib64", "proc", "sbin",
  "tmp", "usr", "var", "workspace",
];
const PROBE_TIMEOUT_MS = 15_000;
const TREE_EXIT_TIMEOUT_MS = 5_000;

function parseArguments(argv) {
  const options = {
    bwrap: "/usr/bin/bwrap",
    dataDirectory: process.env.CHATWCA_DATA_DIR ?? path.resolve("data"),
    piAgentDirectory: process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi", "agent"),
    keepTemporaryDirectory: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--keep-temp") {
      options.keepTemporaryDirectory = true;
      continue;
    }
    const value = argv[index + 1];
    if (argument === "--bwrap" || argument === "--data-dir" || argument === "--pi-agent-dir") {
      if (!value) {
        throw new Error(`${argument} requires a value`);
      }
      index += 1;
      if (argument === "--bwrap") options.bwrap = value;
      if (argument === "--data-dir") options.dataDirectory = value;
      if (argument === "--pi-agent-dir") options.piAgentDirectory = value;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }

  return options;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function canonicalizeExistingOrParent(value) {
  const absolute = path.resolve(value);
  try {
    return await realpath(absolute);
  } catch {
    const parent = await realpath(path.dirname(absolute));
    return path.join(parent, path.basename(absolute));
  }
}

async function compatibilitySymlinkArguments() {
  const links = [
    ["/usr/bin", "usr/bin", "/bin"],
    ["/usr/sbin", "usr/sbin", "/sbin"],
    ["/usr/lib", "usr/lib", "/lib"],
    ["/usr/lib64", "usr/lib64", "/lib64"],
  ];
  const argumentsList = [];
  for (const [source, target, destination] of links) {
    try {
      await access(source, fsConstants.F_OK);
      argumentsList.push("--symlink", target, destination);
    } catch {
      // The production builder is also required to make these links conditional.
    }
  }
  return argumentsList;
}

async function buildProfileArguments(workspace, command) {
  return [
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-net",
    "--hostname", "chatwca-sandbox",
    "--cap-drop", "ALL",
    "--new-session",
    "--die-with-parent",
    "--clearenv",
    "--ro-bind", "/usr", "/usr",
    ...(await compatibilitySymlinkArguments()),
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/home",
    "--dir", "/home/sandbox",
    "--tmpfs", "/tmp",
    "--dir", "/var",
    "--tmpfs", "/var/tmp",
    "--dir", "/etc",
    "--dir", "/app",
    "--bind", workspace, "/workspace",
    "--tmpfs", "/workspace/.chatwca",
    ...Object.entries(EXPECTED_ENVIRONMENT).flatMap(([name, value]) => ["--setenv", name, value]),
    "--chdir", "/workspace",
    ...command,
  ];
}

const CHILD_PROBE_SOURCE = String.raw`
const dns = require("node:dns");
const fs = require("node:fs");
const net = require("node:net");
const { spawnSync } = require("node:child_process");
const hiddenPaths = JSON.parse(Buffer.from(process.argv[1], "base64url").toString("utf8"));
const namespaceNames = ["user", "mnt", "pid", "ipc", "uts", "net"];
const namespaces = Object.fromEntries(namespaceNames.map((name) => [name, fs.readlinkSync("/proc/self/ns/" + name)]));
const status = fs.readFileSync("/proc/self/status", "utf8");
const statusValue = (name) => status.match(new RegExp("^" + name + ":\\s*(.+)$", "m"))?.[1];
const command = (executable, args) => {
  const result = spawnSync(executable, args, { encoding: "utf8", timeout: 3000 });
  return { status: result.status, signal: result.signal, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
};
const connect = (options) => new Promise((resolve) => {
  const socket = net.createConnection(options);
  const finish = (result) => { socket.destroy(); resolve(result); };
  socket.setTimeout(1000, () => finish({ connected: false, error: "timeout" }));
  socket.once("connect", () => finish({ connected: true, error: null }));
  socket.once("error", (error) => finish({ connected: false, error: error.code || "error" }));
});
const lookup = () => new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ resolved: false, error: "timeout" }), 1000);
  dns.lookup("example.com", (error, address) => {
    clearTimeout(timer);
    resolve({ resolved: !error, address: address || null, error: error?.code || null });
  });
});
(async () => {
  fs.writeFileSync("/workspace/write-through.txt", "written in sandbox\n");
  fs.writeFileSync("/workspace/.chatwca/guest-only.txt", "ephemeral\n");
  const result = {
    namespaces,
    hostname: require("node:os").hostname(),
    capEff: statusValue("CapEff"),
    noNewPrivs: statusValue("NoNewPrivs"),
    environment: process.env,
    rootEntries: fs.readdirSync("/").sort(),
    devEntries: fs.readdirSync("/dev").sort(),
    etcEntries: fs.readdirSync("/etc").sort(),
    hiddenPaths: Object.fromEntries(hiddenPaths.map((entry) => [entry.label, fs.existsSync(entry.path)])),
    workspaceRead: fs.readFileSync("/workspace/host-input.txt", "utf8"),
    chatwcaMask: {
      hostSessionVisible: fs.existsSync("/workspace/.chatwca/host-session.json"),
      guestWriteVisible: fs.existsSync("/workspace/.chatwca/guest-only.txt"),
    },
    commands: {
      node: command("/usr/bin/node", ["--version"]),
      bash: command("/bin/bash", ["-lc", "printf bubblewrap-bash"]),
      rg: command("rg", ["--version"]),
    },
    network: {
      ipv4: await connect({ host: "1.1.1.1", port: 53 }),
      ipv6: await connect({ host: "2606:4700:4700::1111", port: 53, family: 6 }),
      loopback4: await connect({ host: "127.0.0.1", port: 9 }),
      loopback6: await connect({ host: "::1", port: 9, family: 6 }),
      dns: await lookup(),
    },
  };
  process.stdout.write(JSON.stringify(result));
})().catch((error) => {
  process.stderr.write(error.stack || String(error));
  process.exitCode = 1;
});
`;

async function runProfileProbe(bwrap, workspace, hiddenPaths) {
  const encodedPaths = Buffer.from(JSON.stringify(hiddenPaths)).toString("base64url");
  const argumentsList = await buildProfileArguments(workspace, [
    "/usr/bin/node", "-e", CHILD_PROBE_SOURCE, encodedPaths,
  ]);
  const result = spawnSync(bwrap, argumentsList, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: PROBE_TIMEOUT_MS,
  });
  assert(!result.error, `Bubblewrap profile failed to launch: ${result.error?.message}`);
  assert(result.status === 0, `Bubblewrap profile exited ${result.status}: ${result.stderr.trim()}`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`Bubblewrap profile returned invalid JSON: ${result.stdout.slice(0, 500)}`);
  }
}

async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const contents = await readFile(file, "utf8");
      if (contents.trim()) return contents;
    } catch {
      // The producer has not created the marker yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${file}`);
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error("timed out waiting for Bubblewrap to exit")), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function processDisappeared(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await stat(`/proc/${pid}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } catch {
      return true;
    }
  }
  return false;
}

async function listProcessTree(rootPid) {
  const entries = await readdir("/proc", { withFileTypes: true });
  const parentByPid = new Map();
  await Promise.all(entries.filter((entry) => /^\d+$/.test(entry.name)).map(async (entry) => {
    try {
      const status = await readFile(`/proc/${entry.name}/status`, "utf8");
      const parentPid = Number(status.match(/^PPid:\s*(\d+)$/m)?.[1]);
      if (Number.isInteger(parentPid)) parentByPid.set(Number(entry.name), parentPid);
    } catch {
      // Processes can exit while /proc is scanned.
    }
  }));

  const tree = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parentPid] of parentByPid) {
      if (tree.has(parentPid) && !tree.has(pid)) {
        tree.add(pid);
        changed = true;
      }
    }
  }
  return [...tree];
}

async function runDescendantCleanupProbe(bwrap, workspace) {
  const marker = path.join(workspace, "tree-ready.txt");
  const script = [
    "sleep 600 &",
    "printf ready > /workspace/tree-ready.txt",
    "wait",
  ].join("\n");
  const argumentsList = await buildProfileArguments(workspace, ["/bin/bash", "-lc", script]);
  const child = spawn(bwrap, argumentsList, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4096); });

  try {
    await waitForFile(marker, PROBE_TIMEOUT_MS);
    const hostPids = await listProcessTree(child.pid);
    assert(hostPids.length >= 3, `expected Bubblewrap, shell, and descendant host PIDs, got ${hostPids.join(", ")}`);

    child.kill("SIGKILL");
    await waitForExit(child, TREE_EXIT_TIMEOUT_MS);
    const cleanupResults = await Promise.all(hostPids.map((pid) => processDisappeared(pid, TREE_EXIT_TIMEOUT_MS)));
    assert(cleanupResults.every(Boolean), `namespace descendants survived Bubblewrap death: ${hostPids.filter((_, index) => !cleanupResults[index]).join(", ")}`);
    return hostPids.length;
  } catch (error) {
    child.kill("SIGKILL");
    await waitForExit(child, TREE_EXIT_TIMEOUT_MS).catch(() => {});
    throw new Error(`${error.message}${stderr ? `; stderr: ${stderr.trim()}` : ""}`);
  }
}

function validateProbe(probe, parentNamespaces) {
  for (const namespace of NAMESPACES) {
    assert(probe.namespaces[namespace] !== parentNamespaces[namespace], `${namespace} namespace matches the parent`);
  }
  assert(probe.hostname === "chatwca-sandbox", `unexpected hostname: ${probe.hostname}`);
  assert(/^0+$/.test(probe.capEff), `effective capabilities are not empty: ${probe.capEff}`);
  assert(probe.noNewPrivs === "1", `NoNewPrivs is ${probe.noNewPrivs}`);
  const environmentNames = Object.keys(probe.environment).sort();
  const expectedEnvironmentNames = Object.keys(EXPECTED_ENVIRONMENT).sort();
  assert(
    JSON.stringify(environmentNames) === JSON.stringify(expectedEnvironmentNames)
      && expectedEnvironmentNames.every((name) => probe.environment[name] === EXPECTED_ENVIRONMENT[name]),
    `sandbox environment differs from the fixed allowlist: ${JSON.stringify(probe.environment)}`,
  );
  assert(JSON.stringify(probe.rootEntries) === JSON.stringify(EXPECTED_ROOT_ENTRIES), `unexpected synthetic root entries: ${probe.rootEntries.join(", ")}`);
  assert(JSON.stringify(probe.devEntries) === JSON.stringify(EXPECTED_DEV_ENTRIES), `unexpected /dev entries: ${probe.devEntries.join(", ")}`);
  assert(probe.etcEntries.length === 0, `host /etc leaked into synthetic /etc: ${probe.etcEntries.join(", ")}`);
  assert(Object.values(probe.hiddenPaths).every((visible) => visible === false), `protected host path visible: ${JSON.stringify(probe.hiddenPaths)}`);
  assert(probe.workspaceRead === "visible in sandbox\n", "workspace host file was not readable");
  assert(probe.chatwcaMask.hostSessionVisible === false, "host .chatwca session is visible");
  assert(probe.chatwcaMask.guestWriteVisible === true, ".chatwca tmpfs is not writable");
  for (const [name, command] of Object.entries(probe.commands)) {
    assert(command.status === 0, `${name} did not execute: ${command.stderr || command.signal || command.status}`);
  }
  assert(/^v(?:2[2-9]|[3-9]\d)\./.test(probe.commands.node.stdout), `sandbox Node is too old: ${probe.commands.node.stdout}`);
  assert(probe.commands.bash.stdout === "bubblewrap-bash", "bash output did not match");
  assert(/^ripgrep\s/i.test(probe.commands.rg.stdout), `unexpected rg output: ${probe.commands.rg.stdout}`);
  for (const [name, result] of Object.entries(probe.network)) {
    const succeeded = "connected" in result ? result.connected : result.resolved;
    assert(succeeded === false, `${name} network probe unexpectedly succeeded`);
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  assert(path.isAbsolute(options.bwrap), "--bwrap must be absolute");
  await access(options.bwrap, fsConstants.X_OK);
  const version = spawnSync(options.bwrap, ["--version"], { encoding: "utf8", timeout: 3000 });
  assert(version.status === 0, `could not execute Bubblewrap: ${version.stderr.trim()}`);

  const temporaryRoot = await mkdtemp(path.join(process.cwd(), ".sandbox-profile-spike-"));
  const workspace = path.join(temporaryRoot, "workspace");
  const unrelatedWorkspace = path.join(temporaryRoot, "unrelated-workspace");
  const parentCanary = path.join(temporaryRoot, "parent-canary.txt");
  const hostTmpCanary = path.join(tmpdir(), `chatwca-sandbox-canary-${process.pid}`);
  await mkdir(path.join(workspace, ".chatwca"), { recursive: true });
  await mkdir(unrelatedWorkspace);
  await writeFile(path.join(workspace, ".chatwca", "host-session.json"), "host session\n");
  await writeFile(path.join(workspace, "host-input.txt"), "visible in sandbox\n");
  await writeFile(path.join(unrelatedWorkspace, "secret.txt"), "unrelated\n");
  await writeFile(parentCanary, "parent only\n");
  await writeFile(hostTmpCanary, "host tmp\n");

  const parentNamespaces = Object.fromEntries(
    await Promise.all(NAMESPACES.map(async (name) => [name, await readlink(`/proc/self/ns/${name}`)])),
  );
  const hiddenPaths = [
    ["parentCanary", parentCanary],
    ["chatwcaData", await canonicalizeExistingOrParent(options.dataDirectory)],
    ["piAgent", await canonicalizeExistingOrParent(options.piAgentDirectory)],
    ["unrelatedWorkspace", unrelatedWorkspace],
    ["hostHome", homedir()],
    ["hostTmpCanary", hostTmpCanary],
    ["hostEtc", "/etc/passwd"],
    ["hostRun", "/run"],
    ["hostSys", "/sys"],
  ].map(([label, filePath]) => ({ label, path: filePath }));

  try {
    const probe = await runProfileProbe(options.bwrap, workspace, hiddenPaths);
    validateProbe(probe, parentNamespaces);
    assert(await readFile(path.join(workspace, "write-through.txt"), "utf8") === "written in sandbox\n", "workspace write did not reach the host");
    const chatwcaEntries = (await readdir(path.join(workspace, ".chatwca"))).sort();
    assert(JSON.stringify(chatwcaEntries) === JSON.stringify(["host-session.json"]), `ephemeral .chatwca write reached host: ${chatwcaEntries.join(", ")}`);
    const descendantCount = await runDescendantCleanupProbe(options.bwrap, workspace);

    console.log(JSON.stringify({
      result: "pass",
      bwrapVersion: version.stdout.trim(),
      nodeVersion: probe.commands.node.stdout,
      rgVersion: probe.commands.rg.stdout.split("\n")[0],
      invocation: process.env.INVOCATION_ID ? "systemd" : "direct",
      namespaces: NAMESPACES,
      networkProbes: Object.keys(probe.network),
      terminatedDescendants: descendantCount,
      temporaryRoot: options.keepTemporaryDirectory ? temporaryRoot : undefined,
    }, null, 2));
  } finally {
    await rm(hostTmpCanary, { force: true });
    if (!options.keepTemporaryDirectory) await rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`Bubblewrap profile spike failed: ${error.message}`);
  process.exitCode = 1;
});
