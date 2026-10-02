export const SEARCH_TEST_TIME = "2025-01-01T00:00:00.000Z";
export const SEARCH_TEST_TIMESTAMP = Date.parse(SEARCH_TEST_TIME);

export function searchSessionHeader(cwd = "/synthetic/workspace", overrides: Record<string, unknown> = {}) {
  return { type: "session", version: 3, id: "synthetic-session", timestamp: SEARCH_TEST_TIME, cwd, ...overrides };
}
export function searchEntry<T extends Record<string, unknown> = Record<string, never>>(id: string, parentId: string | null, fields: T = {} as T) {
  return { type: "custom", id, parentId, timestamp: SEARCH_TEST_TIME, customType: "synthetic", ...fields };
}
export function searchUserEntry(id: string, parentId: string | null, content: unknown = "User dialogue") {
  return searchEntry(id, parentId, { type: "message", message: { role: "user", content, timestamp: SEARCH_TEST_TIMESTAMP } });
}
export function searchAssistantEntry(id: string, parentId: string | null, content: unknown = [{ type: "text", text: "Assistant dialogue" }]) {
  return searchEntry(id, parentId, {
    type: "message", message: {
      role: "assistant", content, timestamp: SEARCH_TEST_TIMESTAMP,
      api: "openai-responses", provider: "synthetic", model: "synthetic-model", stopReason: "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    },
  });
}
export function searchJsonl(records: readonly unknown[], trailingNewline = true): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + (trailingNewline ? "\n" : "");
}
