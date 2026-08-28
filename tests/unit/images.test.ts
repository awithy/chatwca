import { Buffer } from "node:buffer";

import { describe, expect, it, vi } from "vitest";

import { ERROR_CODES } from "../../src/shared/errors.js";
import type { ImageMimeType, UiImage } from "../../src/shared/protocol.js";
import {
  validatePromptImages,
  type ImageValidationLimits,
} from "../../src/server/images.js";

const signatures: Readonly<Record<ImageMimeType, readonly number[]>> = {
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  "image/jpeg": [0xff, 0xd8, 0xff, 0xe0],
  "image/webp": [
    0x52, 0x49, 0x46, 0x46,
    0x04, 0x00, 0x00, 0x00,
    0x57, 0x45, 0x42, 0x50,
  ],
};

const limits: ImageValidationLimits = {
  maxImages: 3,
  maxImageBytes: 64,
  maxTotalImageBytes: 128,
};

function image(
  mimeType: ImageMimeType = "image/png",
  bytes: readonly number[] = signatures[mimeType],
): UiImage {
  return {
    mimeType,
    encoding: "base64",
    data: Buffer.from(bytes).toString("base64"),
    name: "untrusted-name.png",
    width: 1,
    height: 1,
    byteSize: bytes.length,
  };
}

function expectCode(operation: () => unknown, code: string): void {
  expect(operation).toThrow(expect.objectContaining({ code }));
}

describe("server image validation", () => {
  it.each(["image/png", "image/jpeg", "image/webp"] as const)(
    "accepts a signature-matched %s payload and converts only Pi fields",
    (mimeType) => {
      const payload = image(mimeType);
      expect(
        validatePromptImages([payload], { supportsImages: true, limits }),
      ).toEqual([
        { type: "image", mimeType, data: payload.data },
      ]);
    },
  );

  it("rejects data URLs and non-canonical base64 forms", () => {
    const malformed = [
      `data:image/png;base64,${image().data}`,
      "iVBOR",
      "AAAA\n",
      "AA-A",
      "A===",
      "====",
    ];

    for (const data of malformed) {
      expectCode(
        () =>
          validatePromptImages(
            [{ ...image(), data }],
            { supportsImages: true, limits },
          ),
        ERROR_CODES.INVALID_IMAGE,
      );
    }
  });

  it("rejects unsupported declarations, unknown signatures, and MIME spoofing", () => {
    expectCode(
      () =>
        validatePromptImages(
          [{ ...image(), mimeType: "image/gif" } as UiImage],
          { supportsImages: true, limits },
        ),
      ERROR_CODES.INVALID_IMAGE,
    );
    expectCode(
      () =>
        validatePromptImages(
          [image("image/png", [0x00, 0x01, 0x02, 0x03])],
          { supportsImages: true, limits },
        ),
      ERROR_CODES.INVALID_IMAGE,
    );
    expectCode(
      () =>
        validatePromptImages(
          [image("image/jpeg", signatures["image/png"])],
          { supportsImages: true, limits },
        ),
      ERROR_CODES.INVALID_IMAGE,
    );
  });

  it("enforces image count before decoding", () => {
    const decode = vi.spyOn(Buffer, "from");
    try {
      expectCode(
        () =>
          validatePromptImages([image(), image(), image(), image()], {
            supportsImages: true,
            limits,
          }),
        ERROR_CODES.TOO_MANY_IMAGES,
      );
      // Calls above created the fixtures; validation itself made no further call.
      expect(decode).toHaveBeenCalledTimes(4);
    } finally {
      decode.mockRestore();
    }
  });

  it("uses encoded length for the per-image precheck instead of byteSize metadata", () => {
    const payload = { ...image("image/jpeg"), byteSize: 1 };
    const decode = vi.spyOn(Buffer, "from");
    try {
      expectCode(
        () =>
          validatePromptImages([payload], {
            supportsImages: true,
            limits: { ...limits, maxImageBytes: 3 },
          }),
        ERROR_CODES.IMAGE_TOO_LARGE,
      );
      expect(decode).not.toHaveBeenCalled();
    } finally {
      decode.mockRestore();
    }
  });

  it("rejects aggregate decoded bytes before allocating decoded buffers", () => {
    const first = image("image/jpeg");
    const second = image("image/jpeg");
    const decode = vi.spyOn(Buffer, "from");
    try {
      expectCode(
        () =>
          validatePromptImages([first, second], {
            supportsImages: true,
            limits: { ...limits, maxTotalImageBytes: 7 },
          }),
        ERROR_CODES.TOTAL_IMAGE_BYTES_EXCEEDED,
      );
      expect(decode).not.toHaveBeenCalled();
    } finally {
      decode.mockRestore();
    }
  });

  it("rejects images before decoding when the selected model is text-only", () => {
    const payload = image();
    const decode = vi.spyOn(Buffer, "from");
    try {
      expectCode(
        () => validatePromptImages([payload], { supportsImages: false, limits }),
        ERROR_CODES.IMAGE_NOT_SUPPORTED,
      );
      expect(decode).not.toHaveBeenCalled();
    } finally {
      decode.mockRestore();
    }
  });

  it("allows an empty image list for a text-only model", () => {
    expect(
      validatePromptImages([], { supportsImages: false, limits }),
    ).toEqual([]);
  });
});
