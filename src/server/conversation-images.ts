import type { ImageMimeType } from "../shared/protocol.js";

export interface ConversationImage {
  readonly mimeType: ImageMimeType;
  readonly data: Buffer;
}

export interface ConversationImageOwner {
  getImage(
    conversationId: string,
    entryId: string,
    imageIndex: number,
  ): ConversationImage | undefined;
  getWorkspaceImage(
    conversationId: string,
    filePath: string,
  ): Promise<ConversationImage | undefined>;
}

export function workspaceImageUrl(
  conversationId: string,
  filePath: string,
): string {
  return `/api/conversations/${encodeURIComponent(conversationId)}/workspace-images?path=${encodeURIComponent(filePath)}`;
}

/** Same-origin URL for an image retained in a canonical Pi tool-result entry. */
export function conversationImageUrl(
  conversationId: string,
  entryId: string,
  imageIndex: number,
): string {
  return `/api/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(entryId)}/images/${String(imageIndex)}`;
}
