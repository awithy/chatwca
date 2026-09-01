#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const output = path.resolve("dist", "sandbox", "worker.mjs");
await mkdir(path.dirname(output), { recursive: true });
const result = await build({
  entryPoints: [path.resolve("src", "server", "sandbox", "worker-entry.ts")],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.19",
  packages: "external",
  sourcemap: false,
  minify: false,
  legalComments: "none",
  metafile: true,
});
const bundledOutput = Object.values(result.metafile.outputs)[0];
if (bundledOutput === undefined || bundledOutput.imports.some(({ path: imported }) =>
  !imported.startsWith("node:")
)) {
  throw new Error("Sandbox worker bundle contains a non-builtin runtime import");
}
