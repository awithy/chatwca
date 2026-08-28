import { useState, type KeyboardEvent } from "react";

import type {
  LiveConversationStatus,
  QueueState,
} from "../../../shared/protocol.js";
import {
  isComposerSubmitKey,
  type PromptAction,
} from "./chat-interactions.js";

export interface ComposerProps {
  readonly status: LiveConversationStatus;
  readonly draft: string;
  readonly queue: QueueState;
  readonly connected: boolean;
  readonly onDraftChange: (text: string) => void;
  readonly onPrompt: (action: PromptAction, text: string) => Promise<void>;
  readonly onAbort: () => Promise<void>;
  readonly onError: (error: unknown) => void;
}

function actionLabel(action: PromptAction): string {
  switch (action) {
    case "prompt.submit":
      return "Send";
    case "prompt.steer":
      return "Steer";
    case "prompt.followUp":
      return "Follow up";
  }
}

export function Composer({
  status,
  draft,
  queue,
  connected,
  onDraftChange,
  onPrompt,
  onAbort,
  onError,
}: ComposerProps) {
  const [pendingAction, setPendingAction] = useState<PromptAction | "abort" | null>(null);
  const canSendText = connected && pendingAction === null && draft.trim().length > 0;

  async function send(action: PromptAction): Promise<void> {
    const text = draft.trim();
    if (text.length === 0 || pendingAction !== null) return;
    setPendingAction(action);
    try {
      await onPrompt(action, text);
      onDraftChange("");
    } catch (error) {
      onError(error);
    } finally {
      setPendingAction(null);
    }
  }

  async function abort(): Promise<void> {
    if (pendingAction !== null) return;
    setPendingAction("abort");
    try {
      await onAbort();
    } catch (error) {
      onError(error);
    } finally {
      setPendingAction(null);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (!isComposerSubmitKey({
      key: event.key,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing,
    })) return;
    if (status !== "idle" || !canSendText) return;
    event.preventDefault();
    void send("prompt.submit");
  }

  const queued = queue.steering.length + queue.followUp.length;
  const disabled = !connected || pendingAction !== null;

  return (
    <div className="composer-region">
      {queued > 0 && (
        <div className="queue-summary" role="status">
          {queue.steering.length > 0 && <span>{queue.steering.length} steering</span>}
          {queue.followUp.length > 0 && <span>{queue.followUp.length} follow-up</span>}
          <span>{queued === 1 ? "prompt queued" : "prompts queued"}</span>
        </div>
      )}
      <div className={`composer${status === "streaming" ? " is-streaming" : ""}`}>
        <label className="visually-hidden" htmlFor="conversation-composer">Message</label>
        <textarea
          id="conversation-composer"
          rows={3}
          value={draft}
          disabled={!connected || status === "aborting" || status === "error"}
          placeholder={status === "streaming" ? "Add guidance or queue the next prompt…" : "Ask Pi to work on this project…"}
          aria-describedby="composer-hint"
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="composer-footer">
          <span id="composer-hint" className="composer-hint">
            {status === "idle" ? "Enter to send · Shift+Enter for a new line" : "Choose how to deliver this prompt"}
          </span>
          <div className="composer-actions">
            {status === "idle" && (
              <button
                className="primary-button composer-submit"
                type="button"
                disabled={!canSendText}
                onClick={() => void send("prompt.submit")}
              >
                {pendingAction === "prompt.submit" ? "Sending…" : actionLabel("prompt.submit")}
                <span aria-hidden="true">↗</span>
              </button>
            )}
            {status === "streaming" && (
              <>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={disabled || !canSendText}
                  onClick={() => void send("prompt.steer")}
                >
                  {pendingAction === "prompt.steer" ? "Steering…" : actionLabel("prompt.steer")}
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={disabled || !canSendText}
                  onClick={() => void send("prompt.followUp")}
                >
                  {pendingAction === "prompt.followUp" ? "Queueing…" : actionLabel("prompt.followUp")}
                </button>
                <button
                  className="danger-button"
                  type="button"
                  disabled={disabled}
                  onClick={() => void abort()}
                >
                  {pendingAction === "abort" ? "Stopping…" : "Abort"}
                </button>
              </>
            )}
            {status === "aborting" && (
              <button className="danger-button" type="button" disabled>Stopping…</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
