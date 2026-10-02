import { describe, expect, it, vi } from "vitest";
import { createSearchPool } from "../../src/server/search/postgres.js";

describe("lazy optional search pool", () => {
  it("handles idle-client failures without requiring a status subscriber or probing a database", async () => {
    const pool = createSearchPool("postgresql://synthetic:private@127.0.0.1:1/synthetic");
    try {
      expect(pool.totalCount).toBe(0);
      expect(() => pool.emit("error", new Error("private pg diagnostic"))).not.toThrow();
      expect(pool.totalCount).toBe(0);
    } finally { await pool.end(); }
  });

  it("projects only a stable redacted code to the optional idle-error subscriber", async () => {
    const report = vi.fn();
    const pool = createSearchPool("postgresql://synthetic:private@127.0.0.1:1/synthetic", report);
    try {
      pool.emit("error", new Error("credential, SQL and source path"));
      expect(report).toHaveBeenCalledExactlyOnceWith("search_database_unavailable");
      expect(pool.totalCount).toBe(0);
    } finally { await pool.end(); }
  });
});
