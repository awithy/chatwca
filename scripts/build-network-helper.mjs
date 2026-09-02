#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const architecture = { x64: "x64", arm64: "arm64" }[process.arch];
if (process.platform !== "linux" || architecture === undefined) {
  throw new Error("The managed-network helper supports only Linux x64 and arm64");
}

const root = path.resolve();
const manifestPath = path.join(root, "native", "network-helper", "Cargo.toml");
const cargo = process.env.CARGO ?? path.join(process.env.HOME ?? "", ".cargo", "bin", "cargo");

await new Promise((resolve, reject) => {
  const child = spawn(cargo, ["build", "--release", "--locked", "--manifest-path", manifestPath], {
    cwd: root,
    env: process.env,
    shell: false,
    stdio: "inherit",
  });
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (code === 0 && signal === null) resolve();
    else reject(new Error(`cargo build failed (${signal ?? String(code)})`));
  });
});

const source = path.join(root, "native", "network-helper", "target", "release", "chatwca-network-helper");
const outputDirectory = path.join(root, "dist", "native", architecture);
const output = path.join(outputDirectory, "chatwca-network-helper");
const outputTemporary = `${output}.tmp-${process.pid}`;
const manifest = path.join(outputDirectory, "network-helper-manifest.json");
const manifestTemporary = `${manifest}.tmp-${process.pid}`;
await mkdir(outputDirectory, { recursive: true, mode: 0o755 });
try {
  await copyFile(source, outputTemporary);
  await chmod(outputTemporary, 0o500);
  await rename(outputTemporary, output);
  const bytes = await readFile(output);
  const versionOutput = await new Promise((resolve, reject) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    const child = spawn(output, ["--version"], { env: {}, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => { stdout = Buffer.concat([stdout, chunk]); });
    child.stderr.on("data", (chunk) => { stderr = Buffer.concat([stderr, chunk]); });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== 0 || signal !== null || stderr.length !== 0 || stdout.length > 4096) reject(new Error("built helper version check failed"));
      else resolve(stdout.toString("utf8"));
    });
  });
  const reported = JSON.parse(versionOutput);
  if (reported.name !== "chatwca-network-helper" || reported.version !== "1.0.0" || reported.protocol !== 1
      || Object.keys(reported).sort().join(",") !== "name,protocol,version") {
    throw new Error("built helper reported an unexpected version protocol");
  }
  const value = {
    schemaVersion: 1,
    name: reported.name,
    buildVersion: reported.version,
    protocolVersion: reported.protocol,
    platform: "linux",
    architecture,
    file: "chatwca-network-helper",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  await writeFile(manifestTemporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
  await rename(manifestTemporary, manifest);
  console.log(`Built ${path.relative(root, output)} (${value.sha256})`);
} finally {
  await Promise.all([rm(outputTemporary, { force: true }), rm(manifestTemporary, { force: true })]);
}
