import * as React from "react";
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";

import type {
  LiveConversationStatus,
  QueueState,
  UiImage,
} from "../../../shared/protocol.js";
import {
  isComposerSubmitKey,
  type PromptAction,
} from "./chat-interactions.js";
import {
  DEFAULT_BROWSER_IMAGE_LIMITS,
  disposePreparedImages,
  movePreparedImage,
  prepareImageFiles,
  type BrowserImageLimits,
  type PreparedImage,
} from "./image-ingestion.js";

export interface ComposerProps {
  readonly status: LiveConversationStatus;
  readonly draft: string;
  readonly queue: QueueState;
  readonly connected: boolean;
  readonly imageLimits?: BrowserImageLimits;
  readonly onDraftChange: (text: string) => void;
  readonly onPrompt: (
    action: PromptAction,
    text: string,
    images: readonly UiImage[],
  ) => Promise<void>;
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

function formatImageBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export interface ImagePreviewListProps {
  readonly images: readonly PreparedImage[];
  readonly disabled: boolean;
  readonly onRemove: (index: number) => void;
  readonly onMove: (index: number, direction: -1 | 1) => void;
}

/** Ordered, keyboard-operable image previews used by the composer. */
export function ImagePreviewList({
  images,
  disabled,
  onRemove,
  onMove,
}: ImagePreviewListProps) {
  if (images.length === 0) return null;
  return (
    <ol className="image-preview-list" aria-label="Images attached to prompt">
      {images.map((image, index) => {
        const name = image.payload.name ?? `Image ${String(index + 1)}`;
        return (
          <li className="image-preview" key={image.id}>
            <img src={image.previewUrl} alt={`Preview of ${name}`} />
            <div className="image-preview-details">
              <strong title={name}>{name}</strong>
              <span>
                {image.payload.width} × {image.payload.height} · {formatImageBytes(image.payload.byteSize)}
              </span>
            </div>
            <div className="image-preview-actions">
              <button
                type="button"
                disabled={disabled || index === 0}
                aria-label={`Move ${name} earlier`}
                title="Move earlier"
                onClick={() => onMove(index, -1)}
              >
                <span aria-hidden="true">←</span>
              </button>
              <button
                type="button"
                disabled={disabled || index === images.length - 1}
                aria-label={`Move ${name} later`}
                title="Move later"
                onClick={() => onMove(index, 1)}
              >
                <span aria-hidden="true">→</span>
              </button>
              <button
                className="image-remove-button"
                type="button"
                disabled={disabled}
                aria-label={`Remove ${name}`}
                title="Remove image"
                onClick={() => onRemove(index)}
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function Composer({
  status,
  draft,
  queue,
  connected,
  imageLimits = DEFAULT_BROWSER_IMAGE_LIMITS,
  onDraftChange,
  onPrompt,
  onAbort,
  onError,
}: ComposerProps) {
  const [pendingAction, setPendingAction] = useState<PromptAction | "abort" | null>(null);
  const [images, setImages] = useState<PreparedImage[]>([]);
  const [processingImages, setProcessingImages] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const imagesRef = useRef<PreparedImage[]>([]);
  const processingImagesRef = useRef(false);
  const mountedRef = useRef(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canEdit = connected && status !== "aborting" && status !== "error";
  const canSendPrompt =
    canEdit && pendingAction === null && !processingImages &&
    (draft.trim().length > 0 || images.length > 0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      disposePreparedImages(imagesRef.current);
      imagesRef.current = [];
      processingImagesRef.current = false;
    };
  }, []);

  function replaceImages(next: PreparedImage[]): void {
    imagesRef.current = next;
    setImages(next);
  }

  async function addFiles(files: readonly File[]): Promise<void> {
    if (!canEdit || pendingAction !== null || processingImagesRef.current || files.length === 0) return;
    processingImagesRef.current = true;
    setProcessingImages(true);
    setAttachmentError(null);
    try {
      const prepared = await prepareImageFiles(files, imagesRef.current, imageLimits);
      if (!mountedRef.current) {
        disposePreparedImages(prepared);
        return;
      }
      replaceImages([...imagesRef.current, ...prepared]);
    } catch (error) {
      if (!mountedRef.current) return;
      setAttachmentError(
        error instanceof Error ? error.message : "The images could not be prepared.",
      );
    } finally {
      processingImagesRef.current = false;
      if (mountedRef.current) setProcessingImages(false);
      if (fileInputRef.current !== null) fileInputRef.current.value = "";
    }
  }

  async function send(action: PromptAction): Promise<void> {
    const text = draft.trim();
    if ((text.length === 0 && imagesRef.current.length === 0) || pendingAction !== null) return;
    setPendingAction(action);
    const submitted = imagesRef.current;
    try {
      await onPrompt(action, text, submitted.map((image) => image.payload));
      if (mountedRef.current) {
        onDraftChange("");
        disposePreparedImages(submitted);
        replaceImages([]);
        setAttachmentError(null);
      }
    } catch (error) {
      onError(error);
    } finally {
      if (mountedRef.current) setPendingAction(null);
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
      if (mountedRef.current) setPendingAction(null);
    }
  }

  function removeImage(index: number): void {
    if (pendingAction !== null || processingImages) return;
    const removed = imagesRef.current[index];
    if (removed === undefined) return;
    disposePreparedImages([removed]);
    replaceImages(imagesRef.current.filter((_, current) => current !== index));
    setAttachmentError(null);
  }

  function moveImage(index: number, direction: -1 | 1): void {
    if (pendingAction !== null || processingImages) return;
    replaceImages(movePreparedImage(imagesRef.current, index, direction));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (!isComposerSubmitKey({
      key: event.key,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing,
    })) return;
    if (status !== "idle" || !canSendPrompt) return;
    event.preventDefault();
    void send("prompt.submit");
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) return;
    event.preventDefault();
    void addFiles(files);
  }

  function handleFileSelection(event: ChangeEvent<HTMLInputElement>): void {
    void addFiles(Array.from(event.currentTarget.files ?? []));
  }

  function hasDraggedFiles(event: DragEvent<HTMLDivElement>): boolean {
    return Array.from(event.dataTransfer.types).includes("Files");
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>): void {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = canEdit ? "copy" : "none";
    setDraggingFiles(true);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    setDraggingFiles(false);
    void addFiles(Array.from(event.dataTransfer.files));
  }

  const queued = queue.steering.length + queue.followUp.length;
  const disabled = !connected || pendingAction !== null || processingImages;
  const previewControlsDisabled = pendingAction !== null || processingImages;
  const attachmentsDisabled = disabled || status === "aborting" || status === "error";

  return (
    <div className="composer-region">
      {queued > 0 && (
        <div className="queue-summary" role="status">
          {queue.steering.length > 0 && <span>{queue.steering.length} steering</span>}
          {queue.followUp.length > 0 && <span>{queue.followUp.length} follow-up</span>}
          <span>{queued === 1 ? "prompt queued" : "prompts queued"}</span>
        </div>
      )}
      <div
        className={`composer${status === "streaming" ? " is-streaming" : ""}${draggingFiles ? " is-dragging-files" : ""}`}
        onDragEnter={(event) => {
          if (hasDraggedFiles(event)) setDraggingFiles(true);
        }}
        onDragOver={handleDragOver}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setDraggingFiles(false);
          }
        }}
        onDrop={handleDrop}
      >
        <input
          ref={fileInputRef}
          className="visually-hidden"
          type="file"
          tabIndex={-1}
          multiple
          accept="image/png,image/jpeg,image/webp"
          disabled={attachmentsDisabled}
          aria-label="Choose PNG, JPEG, or WebP images"
          onChange={handleFileSelection}
        />
        <ImagePreviewList
          images={images}
          disabled={previewControlsDisabled}
          onRemove={removeImage}
          onMove={moveImage}
        />
        {attachmentError !== null && (
          <p className="attachment-error" role="alert">{attachmentError}</p>
        )}
        {draggingFiles && (
          <div className="image-drop-overlay" aria-hidden="true">Drop images here</div>
        )}
        <label className="visually-hidden" htmlFor="conversation-composer">Message</label>
        <textarea
          id="conversation-composer"
          rows={3}
          value={draft}
          disabled={!canEdit}
          placeholder={status === "streaming" ? "Add guidance or queue the next prompt…" : undefined}
          aria-describedby="composer-hint attachment-limits"
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
        />
        <div className="composer-footer">
          <div className="composer-help">
            <span id="composer-hint" className="composer-hint">
              {status === "idle" ? "Enter to send · Shift+Enter for a new line" : "Choose how to deliver this prompt"}
            </span>
            <span id="attachment-limits" className="visually-hidden">
              Attach up to {imageLimits.maxImages} PNG, JPEG, or WebP images.
            </span>
          </div>
          <div className="composer-actions">
            <button
              className="secondary-button attach-image-button"
              type="button"
              disabled={attachmentsDisabled}
              aria-label="Attach images"
              title={`Attach PNG, JPEG, or WebP images (up to ${String(imageLimits.maxImages)})`}
              onClick={() => fileInputRef.current?.click()}
            >
              <span aria-hidden="true">▧</span>
              <span className="attach-image-label">
                {processingImages ? "Preparing…" : "Image"}
              </span>
            </button>
            {status === "idle" && (
              <button
                className="primary-button composer-submit"
                type="button"
                disabled={!canSendPrompt}
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
                  disabled={disabled || !canSendPrompt}
                  onClick={() => void send("prompt.steer")}
                >
                  {pendingAction === "prompt.steer" ? "Steering…" : actionLabel("prompt.steer")}
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={disabled || !canSendPrompt}
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
