import type { ConversationSummary } from "../../../shared/protocol.js";

/** Keep the selected workspace's newest sessions first without mutating state. */
export function orderConversations(
  conversations: readonly ConversationSummary[],
): ConversationSummary[] {
  return [...conversations].sort((left, right) => {
    const modified = right.modifiedAt - left.modifiedAt;
    return modified === 0 ? left.id.localeCompare(right.id) : modified;
  });
}

export function conversationTitle(conversation: ConversationSummary): string {
  const title = conversation.title.trim();
  return title.length > 0 ? title : "Untitled conversation";
}
