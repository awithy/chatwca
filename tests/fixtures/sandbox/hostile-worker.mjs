// Intentionally compromised transport peer used by worker-client tests.
import fs from "node:fs";

const mode = process.argv[2] ?? "invalid-length";
const response = 9;
const writeAll = (buffer) => {
  let offset = 0;
  while (offset < buffer.length) offset += fs.writeSync(response, buffer, offset, buffer.length - offset);
};
const frame = (value) => {
  const payload = Buffer.from(JSON.stringify(value));
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(payload.length);
  return Buffer.concat([prefix, payload]);
};

if (mode === "partial-prefix") {
  writeAll(Buffer.from([0, 16]));
} else if (mode === "stderr-flood") {
  process.stderr.write("hostile".repeat(100_000));
  writeAll(Buffer.alloc(4));
} else if (mode === "unsolicited") {
  writeAll(frame({ type: "response", id: "spoofed", result: {} }));
} else if (mode === "coalesced-terminals") {
  writeAll(Buffer.concat([
    frame({ type: "shutdown.complete" }),
    frame({ type: "shutdown.complete" }),
  ]));
} else {
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(0xffffffff); writeAll(prefix);
}
setTimeout(() => process.exit(0), 25).unref();
