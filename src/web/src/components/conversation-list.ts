import type { ConversationSummary } from "../../../shared/protocol.js";

export interface ConversationGroup {
  readonly cwd: string;
  readonly conversations: readonly ConversationSummary[];
}

/** Build stable workspace groups while keeping the newest sessions first. */
export function groupConversations(
  conversations: readonly ConversationSummary[],
  cwdFilter: string | null,
): ConversationGroup[] {
  const groups = new Map<string, ConversationSummary[]>();

  for (const conversation of conversations) {
    if (cwdFilter !== null && conversation.cwd !== cwdFilter) continue;
    const group = groups.get(conversation.cwd) ?? [];
    group.push(conversation);
    groups.set(conversation.cwd, group);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([cwd, items]) => ({
      cwd,
      conversations: items.sort((left, right) => right.modifiedAt - left.modifiedAt),
    }));
}

export function conversationTitle(conversation: ConversationSummary): string {
  const title = conversation.title.trim();
  return title.length > 0 ? title : "Untitled conversation";
}
