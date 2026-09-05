import type { ChatClientState } from "./state.js";

/** Drafts have a composer-local subscription, not an application-wide one. */
export type ChatViewState = Omit<ChatClientState, "drafts">;

/** Keep the external-store snapshot stable when only drafts change. */
export function createChatViewSnapshot(getState: () => ChatClientState): () => ChatViewState {
  let previous = getState();
  const { drafts: _drafts, ...initialView } = previous;
  let view: ChatViewState = initialView;
  const keys = Object.keys(view) as (keyof ChatViewState)[];

  return () => {
    const next = getState();
    if (next !== previous) {
      if (keys.some((key) => !Object.is(previous[key], next[key]))) {
        const { drafts: _nextDrafts, ...nextView } = next;
        view = nextView;
      }
      previous = next;
    }
    return view;
  };
}
