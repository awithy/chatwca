import type { PublicConfig } from "../../../shared/protocol.js";

export const CONVERSATION_HISTORY_DISCLOSURE = "Search and read cached user/assistant dialogue from all registered workspaces. These tools run outside workspace sandboxing. Retrieved dialogue can be sent to this conversation’s model provider; search may also use optional provider reranking.";

/** Availability describes calls, not the immutable runtime tool grant. */
export function conversationHistoryAvailability(search: PublicConfig["search"]): string {
  if (search === undefined) return "Unavailable — search configuration unavailable";
  if (search.mode === "disabled") return "Unavailable — search is disabled; stored selection is retained";
  if (search.state === "ready" && search.available) return "Available — cached history ready";
  return `Enabled — cached history ${search.state}; selected tools remain granted but calls may fail`;
}
