import { useCallback, useSyncExternalStore } from "react";

import type { ChatSocketClient } from "../api/client.js";
import { Composer, type ComposerProps } from "./Composer.js";

interface DraftComposerProps extends Omit<ComposerProps, "draft" | "onDraftChange"> {
  readonly client: ChatSocketClient;
  readonly conversationId: string;
}

/** Preserve immediate per-conversation drafts without re-rendering the page. */
export function DraftComposer({ client, conversationId, ...props }: DraftComposerProps) {
  const getDraft = useCallback(
    () => client.getState().drafts[conversationId] ?? "",
    [client, conversationId],
  );
  const draft = useSyncExternalStore(client.subscribe, getDraft, getDraft);
  const onDraftChange = useCallback(
    (text: string) => client.setDraft(conversationId, text),
    [client, conversationId],
  );

  return <Composer {...props} draft={draft} onDraftChange={onDraftChange} />;
}
