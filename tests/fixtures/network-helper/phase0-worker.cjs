"use strict";

const childProcess = require("node:child_process");
const dns = require("node:dns");
const fs = require("node:fs");
const net = require("node:net");

const namespaces = ["user", "mnt", "pid", "ipc", "uts", "net"];
const status = fs.readFileSync("/proc/self/status", "utf8");
const statusValue = (name) => status.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1];

function exchange(port, label) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let response = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`${label} bridge timed out`));
    }, 2_000);
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { response += chunk; });
    socket.once("connect", () => socket.end(`phase0-${label}`));
    socket.once("end", () => {
      clearTimeout(timer);
      resolve(response);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function failedConnection(options) {
  return new Promise((resolve) => {
    const socket = net.createConnection(options);
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(750, () => finish(true));
    socket.once("connect", () => finish(false));
    socket.once("error", () => finish(true));
  });
}

function failedDns() {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(true), 750);
    dns.lookup("phase0.invalid", (error) => {
      clearTimeout(timer);
      resolve(Boolean(error));
    });
  });
}

function unixSocketDenied() {
  return new Promise((resolve) => {
    const target = "/tmp/phase0-forbidden.sock";
    const server = net.createServer();
    server.once("error", (error) => resolve({ denied: true, code: error.code }));
    server.listen(target, () => {
      server.close();
      resolve({ denied: false, code: null });
    });
  });
}

function unexpectedDescriptors() {
  const descriptors = [];
  for (let descriptor = 3; descriptor < 64; descriptor += 1) {
    try {
      const target = fs.readlinkSync(`/proc/self/fd/${descriptor}`);
      if (target.startsWith("socket:[") || target.includes("memfd:chatwca-phase0")) {
        descriptors.push([descriptor, target]);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return descriptors;
}

(async () => {
  const helper = fs.statSync("/app/network-helper");
  const worker = fs.statSync("/app/worker.cjs");
  const writeDenied = (target) => {
    try {
      fs.openSync(target, "w");
      return false;
    } catch (error) {
      return ["EROFS", "EACCES", "EPERM"].includes(error.code);
    }
  };
  const version = childProcess.spawnSync("/app/network-helper", ["--version"], {
    encoding: "utf8",
    env: {},
    shell: false,
    timeout: 2_000,
  });
  const ready = {
    type: "phase0-ready",
    namespaces: Object.fromEntries(namespaces.map((name) => [
      name,
      fs.readlinkSync(`/proc/self/ns/${name}`),
    ])),
    security: {
      capInh: statusValue("CapInh"),
      capPrm: statusValue("CapPrm"),
      capEff: statusValue("CapEff"),
      capBnd: statusValue("CapBnd"),
      capAmb: statusValue("CapAmb"),
      noNewPrivs: statusValue("NoNewPrivs"),
      seccomp: statusValue("Seccomp"),
      nativeChecks: process.env.PHASE0_SECCOMP_CHECKED,
      unixSocket: await unixSocketDenied(),
    },
    environment: process.env,
    artifact: {
      helperMode: helper.mode & 0o777,
      helperWriteDenied: writeDenied("/app/network-helper"),
      workerMode: worker.mode & 0o777,
      workerWriteDenied: writeDenied("/app/worker.cjs"),
      versionStatus: version.status,
      version: version.stdout.trim(),
    },
    bridges: {
      http: await exchange(Number(process.env.PHASE0_HTTP_PORT), "http"),
      socks: await exchange(Number(process.env.PHASE0_SOCKS_PORT), "socks"),
    },
    blockedNetwork: {
      arbitraryLoopback: await failedConnection({ host: "127.0.0.2", port: 9 }),
      ipv4: await failedConnection({ host: "192.0.2.1", port: 9 }),
      ipv6: await failedConnection({ host: "2001:db8::1", port: 9, family: 6 }),
      dns: await failedDns(),
    },
    unexpectedDescriptors: unexpectedDescriptors(),
  };
  process.stdout.write(`${JSON.stringify(ready)}\n`);
  setInterval(() => {}, 60_000);
})().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exit(1);
});
