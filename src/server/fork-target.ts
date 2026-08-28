import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Pi v3 session entry IDs are the first eight lowercase hex UUID characters. */
export const PI_ENTRY_ID_PATTERN = /^[0-9a-f]{8}$/;

export function isPiEntryId(value: unknown): value is string {
  return typeof value === "string" && PI_ENTRY_ID_PATTERN.test(value);
}

/**
 * Forking before an entry is supported only for canonical user-message entries
 * on the session manager's current root-to-leaf path. Looking only at
 * `getEntry()` would incorrectly admit entries on abandoned branches.
 */
export function isActiveBranchUserEntry(
  branch: readonly SessionEntry[] | readonly unknown[],
  entryId: string,
): boolean {
  if (!isPiEntryId(entryId)) return false;

  return branch.some((value) => {
    if (typeof value !== "object" || value === null) return false;
    const entry = value as {
      readonly type?: unknown;
      readonly id?: unknown;
      readonly message?: { readonly role?: unknown };
    };
    return (
      entry.type === "message" &&
      entry.id === entryId &&
      entry.message?.role === "user"
    );
  });
}
