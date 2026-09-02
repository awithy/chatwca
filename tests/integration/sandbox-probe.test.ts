import { mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/server/config.js";
import { validateBwrapAndToolchain } from "../../src/server/sandbox/bwrap.js";
import { validateNetworkHelper } from "../../src/server/network/helper.js";
import {
  loadSandboxWorkerArtifact,
  runSandboxStartupProbe,
} from "../../src/server/sandbox/probe.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe.skipIf(process.env.CHATWCA_SANDBOX_CAPABLE !== "1")("real Bubblewrap startup probe", () => {
  it("validates the production executable/toolchain and complete functional boundary", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "chatwca-real-probe-"));
    temporaryDirectories.push(root);
    const dataDirectory = await mkdtemp(path.join(root, "data-"));
    const piAgentDirectory = await mkdtemp(path.join(root, "pi-"));
    const readOnlyToolchain = await mkdtemp(path.join(homedir(), ".chatwca-probe-toolchain-"));
    temporaryDirectories.push(readOnlyToolchain);
    const loaded = loadConfig({
      CHATWCA_SANDBOX_MODE: "optional",
      CHATWCA_WORKSPACE_ROOTS: "[]",
      CHATWCA_DATA_DIR: dataDirectory,
      PI_CODING_AGENT_DIR: piAgentDirectory,
      CHATWCA_SANDBOX_RO_MOUNTS: JSON.stringify([readOnlyToolchain]),
      CHATWCA_MANAGED_EGRESS_MODE: "optional",
      CHATWCA_NETWORK_ALLOWED_DOMAINS: '["example.com"]',
    });
    const host = validateBwrapAndToolchain(loaded.sandbox);
    const worker = await loadSandboxWorkerArtifact();
    const helper = validateNetworkHelper({
      helperPath: loaded.managedNetwork.helperPath,
      manifestPath: loaded.managedNetwork.helperManifestPath,
      protectedPaths: [await realpath(dataDirectory), await realpath(piAgentDirectory), readOnlyToolchain],
    });

    await expect(runSandboxStartupProbe({
      config: loaded.sandbox,
      host,
      worker,
      dataDirectory: await realpath(dataDirectory),
      piAgentDirectory: await realpath(piAgentDirectory),
      managedNetwork: { config: loaded.managedNetwork, helper },
    })).resolves.toMatchObject({
      succeeded: true,
      managedEgressSucceeded: true,
      bwrapVersion: expect.stringMatching(/^bubblewrap /),
      nodeVersion: expect.stringMatching(/^v/),
      rgVersion: expect.stringMatching(/^ripgrep /),
      workerSha256: worker.sha256,
    });
  }, 20_000);
});
