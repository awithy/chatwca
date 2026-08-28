import type { LiveConversationStatus } from "../../../shared/protocol.js";

export type PromptAction = "prompt.submit" | "prompt.steer" | "prompt.followUp";

export function canCloseConversation(
  status: LiveConversationStatus,
  hasLiveConversation = true,
): boolean {
  return hasLiveConversation && status !== "streaming" && status !== "aborting";
}

export function canDeleteConversation(
  status: LiveConversationStatus | "closed",
): boolean {
  return status !== "streaming" && status !== "aborting";
}

export function isComposerSubmitKey(event: {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly isComposing: boolean;
}): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing;
}
