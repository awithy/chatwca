import type { PromptOptions } from "@earendil-works/pi-coding-agent";

import { AppError, ERROR_CODES } from "../shared/errors.js";
import type { ImageMimeType, UiImage } from "../shared/protocol.js";
import {
  DEFAULT_MAX_IMAGES,
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_MAX_TOTAL_IMAGE_BYTES,
} from "./config.js";

export interface ImageValidationLimits {
  readonly maxImages: number;
  readonly maxImageBytes: number;
  readonly maxTotalImageBytes: number;
}

export interface ImageValidationOptions {
  readonly supportsImages: boolean;
  readonly limits?: Readonly<ImageValidationLimits>;
}

export type PiImageContent = NonNullable<PromptOptions["images"]>[number];

export const DEFAULT_IMAGE_VALIDATION_LIMITS: Readonly<ImageValidationLimits> =
  Object.freeze({
    maxImages: DEFAULT_MAX_IMAGES,
    maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
    maxTotalImageBytes: DEFAULT_MAX_TOTAL_IMAGE_BYTES,
  });

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MIME_TYPES = new Set<ImageMimeType>([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

interface EncodedImage {
  readonly image: UiImage;
  readonly decodedBytes: number;
}

function assertLimits(limits: Readonly<ImageValidationLimits>): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
}

function invalidImage(cause?: unknown): AppError {
  return new AppError(ERROR_CODES.INVALID_IMAGE, { cause });
}

function isImageMimeType(value: unknown): value is ImageMimeType {
  return typeof value === "string" && MIME_TYPES.has(value as ImageMimeType);
}

/**
 * Validate canonical, standard base64 and determine its decoded size without
 * allocating a decoded Buffer. ChatWCA's wire format deliberately carries raw
 * base64; data URLs, whitespace, URL-safe base64, and omitted padding are not
 * accepted.
 */
function decodedByteLength(data: unknown, maxImageBytes: number): number {
  if (typeof data !== "string" || data.length === 0 || /^data:/i.test(data)) {
    throw invalidImage();
  }

  // Any legal encoding within the decoded limit is no longer than this. This
  // cheap check rejects oversized strings before regex validation or decoding.
  const maximumEncodedLength = 4 * Math.ceil(maxImageBytes / 3);
  if (data.length > maximumEncodedLength) {
    throw new AppError(ERROR_CODES.IMAGE_TOO_LARGE);
  }

  if (
    data.length % 4 !== 0 ||
    !BASE64_PATTERN.test(data)
  ) {
    throw invalidImage();
  }

  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const decodedBytes = (data.length / 4) * 3 - padding;
  if (decodedBytes <= 0) throw invalidImage();
  if (decodedBytes > maxImageBytes) {
    throw new AppError(ERROR_CODES.IMAGE_TOO_LARGE);
  }
  return decodedBytes;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return (
    bytes.length >= signature.length &&
    signature.every((value, index) => bytes[index] === value)
  );
}

function detectedMimeType(bytes: Uint8Array): ImageMimeType | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes.length >= 12 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
}

function precheckImage(
  value: UiImage,
  maxImageBytes: number,
): EncodedImage {
  if (
    typeof value !== "object" ||
    value === null ||
    value.encoding !== "base64" ||
    !isImageMimeType(value.mimeType)
  ) {
    throw invalidImage();
  }

  return {
    image: value,
    decodedBytes: decodedByteLength(value.data, maxImageBytes),
  };
}

/**
 * Validate untrusted wire images and convert them to Pi's provider-neutral
 * ImageContent shape. The decoded buffers exist only long enough to inspect
 * magic bytes; Pi receives the original canonical base64 and persists it in
 * its native session store.
 */
export function validatePromptImages(
  images: readonly UiImage[],
  options: Readonly<ImageValidationOptions>,
): PiImageContent[] {
  const limits = options.limits ?? DEFAULT_IMAGE_VALIDATION_LIMITS;
  assertLimits(limits);

  if (images.length === 0) return [];
  if (images.length > limits.maxImages) {
    throw new AppError(ERROR_CODES.TOO_MANY_IMAGES);
  }
  if (!options.supportsImages) {
    throw new AppError(ERROR_CODES.IMAGE_NOT_SUPPORTED);
  }

  // Complete encoded-size checks for the whole request before allocating even
  // one decoded Buffer. Client-supplied byteSize metadata is intentionally not
  // trusted for either per-image or aggregate accounting.
  const checked: EncodedImage[] = [];
  let totalDecodedBytes = 0;
  for (const image of images) {
    const encoded = precheckImage(image, limits.maxImageBytes);
    totalDecodedBytes += encoded.decodedBytes;
    if (
      !Number.isSafeInteger(totalDecodedBytes) ||
      totalDecodedBytes > limits.maxTotalImageBytes
    ) {
      throw new AppError(ERROR_CODES.TOTAL_IMAGE_BYTES_EXCEEDED);
    }
    checked.push(encoded);
  }

  return checked.map(({ image, decodedBytes }) => {
    const decoded = Buffer.from(image.data, "base64");
    // Keep a canonical round-trip guard alongside the strict grammar so future
    // Node base64 decoder changes cannot make this boundary permissive.
    if (
      decoded.byteLength !== decodedBytes ||
      decoded.toString("base64") !== image.data ||
      detectedMimeType(decoded) !== image.mimeType
    ) {
      throw invalidImage();
    }

    return {
      type: "image",
      data: image.data,
      mimeType: image.mimeType,
    };
  });
}
