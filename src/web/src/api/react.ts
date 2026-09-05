import { useEffect, useMemo, useSyncExternalStore } from "react";

import { ChatSocketClient, type ChatSocketClientOptions } from "./client.js";
import { createChatViewSnapshot } from "./view-state.js";

/** Expose application state without subscribing the whole page to draft edits. */
export function useChatSocket(options?: ChatSocketClientOptions) {
  const client = useMemo(() => new ChatSocketClient(options), []);
  const getSnapshot = useMemo(() => createChatViewSnapshot(client.getState), [client]);
  const state = useSyncExternalStore(client.subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    client.connect();
    return () => client.disconnect();
  }, [client]);

  return { client, state } as const;
}
