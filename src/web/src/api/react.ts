import { useEffect, useMemo, useSyncExternalStore } from "react";

import { ChatSocketClient, type ChatSocketClientOptions } from "./client.js";

/** Create a client for the component lifetime and expose its immutable state. */
export function useChatSocket(options?: ChatSocketClientOptions) {
  const client = useMemo(() => new ChatSocketClient(options), []);
  const state = useSyncExternalStore(
    client.subscribe,
    client.getState,
    client.getState,
  );

  useEffect(() => {
    client.connect();
    return () => client.disconnect();
  }, [client]);

  return { client, state } as const;
}
