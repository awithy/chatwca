import type { ImageMimeType, UiImage } from "../../../shared/protocol.js";

export const MAX_IMAGE_EDGE = 2048;
export const DEFAULT_BROWSER_IMAGE_LIMITS: BrowserImageLimits = {
  maxImages: 8,
  maxImageBytes: 8 * 1024 * 1024,
  maxTotalImageBytes: 24 * 1024 * 1024,
};

const ACCEPTED_MIME_TYPES = new Set<ImageMimeType>([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

export interface BrowserImageLimits {
  readonly maxImages: number;
  readonly maxImageBytes: number;
  readonly maxTotalImageBytes: number;
}

export interface PreparedImage {
  readonly id: string;
  readonly previewUrl: string;
  readonly payload: UiImage & {
    readonly width: number;
    readonly height: number;
    readonly byteSize: number;
  };
}

export interface DecodedBrowserImage {
  readonly source: CanvasImageSource;
  readonly width: number;
  readonly height: number;
  readonly close: () => void;
}

export interface ImageBrowserApi {
  readonly decode: (file: File) => Promise<DecodedBrowserImage>;
  readonly encode: (
    source: CanvasImageSource,
    width: number,
    height: number,
    mimeType: ImageMimeType,
  ) => Promise<Blob>;
  readonly createObjectURL: (blob: Blob) => string;
  readonly revokeObjectURL: (url: string) => void;
  readonly createId: () => string;
}

export class ImageIngestionError extends Error {
  override readonly name = "ImageIngestionError";
}

function imageName(file: File): string {
  const name = file.name.trim() || "Pasted image";
  return name.slice(0, 255);
}

function formatMebibytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 1024 * 1024 ? 1 : 0)} MiB`;
}

function assertLimits(limits: BrowserImageLimits): void {
  if (
    !Number.isSafeInteger(limits.maxImages) || limits.maxImages <= 0 ||
    !Number.isSafeInteger(limits.maxImageBytes) || limits.maxImageBytes <= 0 ||
    !Number.isSafeInteger(limits.maxTotalImageBytes) || limits.maxTotalImageBytes <= 0
  ) {
    throw new RangeError("Image limits must be positive integers.");
  }
}

function mimeTypeOf(file: File): ImageMimeType {
  if (ACCEPTED_MIME_TYPES.has(file.type as ImageMimeType)) {
    return file.type as ImageMimeType;
  }
  throw new ImageIngestionError(
    `${imageName(file)} is not a supported image. Choose a PNG, JPEG, or WebP file.`,
  );
}

/** Compute the canvas size from orientation-corrected decoder dimensions. */
export function resizedImageDimensions(
  width: number,
  height: number,
  maxEdge = MAX_IMAGE_EDGE,
): { readonly width: number; readonly height: number } {
  if (
    !Number.isFinite(width) || width <= 0 ||
    !Number.isFinite(height) || height <= 0 ||
    !Number.isSafeInteger(maxEdge) || maxEdge <= 0
  ) {
    throw new ImageIngestionError("The image has invalid dimensions.");
  }
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function loadHtmlImage(file: File): Promise<DecodedBrowserImage> {
  return new Promise((resolve, reject) => {
    const sourceUrl = URL.createObjectURL(file);
    const image = new Image();
    const release = (): void => URL.revokeObjectURL(sourceUrl);
    image.onload = () => {
      release();
      // Current browsers apply EXIF orientation when decoding HTML images.
      resolve({
        source: image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        close: () => undefined,
      });
    };
    image.onerror = () => {
      release();
      reject(new ImageIngestionError(`${imageName(file)} could not be decoded.`));
    };
    image.src = sourceUrl;
  });
}

/** Decode with EXIF orientation applied before dimensions are inspected. */
export async function decodeBrowserImage(file: File): Promise<DecodedBrowserImage> {
  if (typeof globalThis.createImageBitmap === "function") {
    try {
      const bitmap = await globalThis.createImageBitmap(file, {
        imageOrientation: "from-image",
      });
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      };
    } catch {
      // HTMLImageElement is an orientation-aware fallback for browsers whose
      // createImageBitmap implementation cannot decode a supported format.
    }
  }
  return loadHtmlImage(file);
}

/** Draw and encode one image, immediately releasing the temporary canvas. */
export async function encodeBrowserImage(
  source: CanvasImageSource,
  width: number,
  height: number,
  mimeType: ImageMimeType,
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  try {
    const context = canvas.getContext("2d");
    if (context === null) {
      throw new ImageIngestionError("This browser cannot resize images.");
    }
    context.drawImage(source, 0, 0, width, height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (result) => result === null
          ? reject(new ImageIngestionError("The resized image could not be encoded."))
          : resolve(result),
        mimeType,
        mimeType === "image/png" ? undefined : 0.9,
      );
    });
    if (blob.type !== mimeType) {
      const format = mimeType.replace("image/", "").toUpperCase();
      throw new ImageIngestionError(
        `This browser cannot encode ${format} images.`,
      );
    }
    return blob;
  } finally {
    // Setting both dimensions to zero releases the canvas backing store.
    canvas.width = 0;
    canvas.height = 0;
  }
}

let imageId = 0;

function defaultBrowserApi(): ImageBrowserApi {
  return {
    decode: decodeBrowserImage,
    encode: encodeBrowserImage,
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    createId: () => `image-${Date.now().toString(36)}-${(++imageId).toString(36)}`,
  };
}

async function blobBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

/**
 * Validate and prepare a batch atomically. Existing previews are never changed
 * on failure, and any URLs created for the rejected batch are revoked.
 */
export async function prepareImageFiles(
  files: readonly File[],
  existing: readonly PreparedImage[],
  limits: BrowserImageLimits,
  api: ImageBrowserApi = defaultBrowserApi(),
): Promise<PreparedImage[]> {
  assertLimits(limits);
  if (files.length === 0) return [];
  if (existing.length + files.length > limits.maxImages) {
    throw new ImageIngestionError(
      `Attach no more than ${String(limits.maxImages)} images to one prompt.`,
    );
  }

  let preliminaryTotal = existing.reduce(
    (total, image) => total + image.payload.byteSize,
    0,
  );
  const typedFiles = files.map((file) => {
    const mimeType = mimeTypeOf(file);
    if (file.size <= 0) {
      throw new ImageIngestionError(`${imageName(file)} is empty.`);
    }
    if (file.size > limits.maxImageBytes) {
      throw new ImageIngestionError(
        `${imageName(file)} exceeds the ${formatMebibytes(limits.maxImageBytes)} per-image limit.`,
      );
    }
    preliminaryTotal += file.size;
    if (preliminaryTotal > limits.maxTotalImageBytes) {
      throw new ImageIngestionError(
        `The attached images exceed the ${formatMebibytes(limits.maxTotalImageBytes)} total limit.`,
      );
    }
    return { file, mimeType };
  });

  const prepared: PreparedImage[] = [];
  let encodedTotal = existing.reduce(
    (total, image) => total + image.payload.byteSize,
    0,
  );
  try {
    for (const { file, mimeType } of typedFiles) {
      let decoded: DecodedBrowserImage | undefined;
      try {
        decoded = await api.decode(file);
        const dimensions = resizedImageDimensions(decoded.width, decoded.height);
        const blob = await api.encode(
          decoded.source,
          dimensions.width,
          dimensions.height,
          mimeType,
        );
        if (blob.size <= 0 || blob.size > limits.maxImageBytes) {
          throw new ImageIngestionError(
            `${imageName(file)} exceeds the ${formatMebibytes(limits.maxImageBytes)} limit after resizing.`,
          );
        }
        encodedTotal += blob.size;
        if (encodedTotal > limits.maxTotalImageBytes) {
          throw new ImageIngestionError(
            `The resized images exceed the ${formatMebibytes(limits.maxTotalImageBytes)} total limit.`,
          );
        }
        const data = await blobBase64(blob);
        const id = api.createId();
        const previewUrl = api.createObjectURL(blob);
        prepared.push({
          id,
          previewUrl,
          payload: {
            mimeType,
            encoding: "base64",
            data,
            name: imageName(file),
            width: dimensions.width,
            height: dimensions.height,
            byteSize: blob.size,
          },
        });
      } finally {
        decoded?.close();
      }
    }
    return prepared;
  } catch (error) {
    disposePreparedImages(prepared, api.revokeObjectURL);
    if (error instanceof ImageIngestionError) throw error;
    throw new ImageIngestionError("One of the images could not be prepared.");
  }
}

export function disposePreparedImages(
  images: readonly PreparedImage[],
  revokeObjectURL: (url: string) => void = (url) => URL.revokeObjectURL(url),
): void {
  for (const image of images) revokeObjectURL(image.previewUrl);
}

export function movePreparedImage(
  images: readonly PreparedImage[],
  index: number,
  direction: -1 | 1,
): PreparedImage[] {
  const destination = index + direction;
  if (
    index < 0 || index >= images.length ||
    destination < 0 || destination >= images.length
  ) {
    return [...images];
  }
  const moved = [...images];
  const [image] = moved.splice(index, 1);
  if (image !== undefined) moved.splice(destination, 0, image);
  return moved;
}
