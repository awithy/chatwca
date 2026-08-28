import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Composer, ImagePreviewList } from "../../src/web/src/components/Composer.js";
import {
  decodeBrowserImage,
  disposePreparedImages,
  encodeBrowserImage,
  ImageIngestionError,
  movePreparedImage,
  prepareImageFiles,
  resizedImageDimensions,
  type ImageBrowserApi,
  type PreparedImage,
} from "../../src/web/src/components/image-ingestion.js";

const limits = {
  maxImages: 3,
  maxImageBytes: 100,
  maxTotalImageBytes: 200,
};

function file(name: string, type = "image/png", bytes = 10): File {
  return new File([new Uint8Array(bytes).fill(1)], name, { type });
}

function prepared(id: string, bytes = 3): PreparedImage {
  return {
    id,
    previewUrl: `blob:${id}`,
    payload: {
      mimeType: "image/png",
      encoding: "base64",
      data: "AQID",
      name: `${id}.png`,
      width: 100,
      height: 50,
      byteSize: bytes,
    },
  };
}

function fakeApi(options: {
  readonly width?: number;
  readonly height?: number;
  readonly outputBytes?: number;
} = {}): ImageBrowserApi & {
  readonly decode: ReturnType<typeof vi.fn>;
  readonly encode: ReturnType<typeof vi.fn>;
  readonly revokeObjectURL: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
} {
  const close = vi.fn();
  let id = 0;
  return {
    close,
    decode: vi.fn(async () => ({
      source: {} as CanvasImageSource,
      width: options.width ?? 100,
      height: options.height ?? 50,
      close,
    })),
    encode: vi.fn(async (_source, _width, _height, mimeType) =>
      new Blob([new Uint8Array(options.outputBytes ?? 3).fill(1)], { type: mimeType })),
    createObjectURL: vi.fn(() => `blob:preview-${++id}`),
    revokeObjectURL: vi.fn(),
    createId: vi.fn(() => `image-${String(id)}`),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("browser image ingestion", () => {
  it("uses orientation-corrected dimensions and resizes the maximum edge to 2048", async () => {
    // A portrait result here represents a landscape sensor image whose EXIF
    // orientation was applied by the decoder before sizing.
    expect(resizedImageDimensions(3000, 4000)).toEqual({
      width: 1536,
      height: 2048,
    });

    const api = fakeApi({ width: 3000, height: 4000 });
    const [image] = await prepareImageFiles([file("portrait.jpg", "image/jpeg")], [], limits, api);

    expect(api.encode).toHaveBeenCalledWith(
      expect.anything(),
      1536,
      2048,
      "image/jpeg",
    );
    expect(api.close).toHaveBeenCalledOnce();
    expect(image?.payload).toMatchObject({
      mimeType: "image/jpeg",
      encoding: "base64",
      data: "AQEB",
      name: "portrait.jpg",
      width: 1536,
      height: 2048,
      byteSize: 3,
    });
    expect(image?.previewUrl).toBe("blob:preview-1");
  });

  it.each(["image/png", "image/jpeg", "image/webp"] as const)(
    "accepts and preserves the supported %s format",
    async (mimeType) => {
      const api = fakeApi();
      const [image] = await prepareImageFiles([file("image", mimeType)], [], limits, api);
      expect(image?.payload.mimeType).toBe(mimeType);
      expect(api.encode).toHaveBeenCalledWith(expect.anything(), 100, 50, mimeType);
    },
  );

  it("requests EXIF orientation from createImageBitmap", async () => {
    const close = vi.fn();
    const bitmap = { width: 20, height: 30, close };
    const createImageBitmap = vi.fn(async () => bitmap);
    vi.stubGlobal("createImageBitmap", createImageBitmap);

    const decoded = await decodeBrowserImage(file("camera.jpg", "image/jpeg"));
    expect(createImageBitmap).toHaveBeenCalledWith(
      expect.any(File),
      { imageOrientation: "from-image" },
    );
    expect(decoded).toMatchObject({ width: 20, height: 30 });
    decoded.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("releases the temporary canvas backing store after encoding", async () => {
    const drawImage = vi.fn();
    const canvas = {
      width: -1,
      height: -1,
      getContext: vi.fn(() => ({ drawImage })),
      toBlob: vi.fn((callback: (blob: Blob | null) => void) => {
        callback(new Blob([new Uint8Array([1])], { type: "image/webp" }));
      }),
    };
    vi.stubGlobal("document", { createElement: vi.fn(() => canvas) });

    await expect(
      encodeBrowserImage({} as CanvasImageSource, 640, 480, "image/webp"),
    ).resolves.toBeInstanceOf(Blob);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 640, 480);
    expect(canvas).toMatchObject({ width: 0, height: 0 });
  });

  it("rejects unsupported types, count, individual size, and aggregate size before decoding", async () => {
    const api = fakeApi();
    await expect(
      prepareImageFiles([file("animation.gif", "image/gif")], [], limits, api),
    ).rejects.toThrow("PNG, JPEG, or WebP");
    await expect(
      prepareImageFiles([file("fourth.png")], [prepared("1"), prepared("2"), prepared("3")], limits, api),
    ).rejects.toThrow("no more than 3");
    await expect(
      prepareImageFiles([file("large.png", "image/png", 101)], [], limits, api),
    ).rejects.toThrow("per-image limit");
    await expect(
      prepareImageFiles(
        [file("one.png", "image/png", 60), file("two.png", "image/png", 60)],
        [prepared("existing", 90)],
        limits,
        api,
      ),
    ).rejects.toThrow("total limit");
    expect(api.decode).not.toHaveBeenCalled();
  });

  it("atomically closes decoded images and revokes batch previews on failure", async () => {
    const api = fakeApi();
    api.encode
      .mockResolvedValueOnce(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }))
      .mockRejectedValueOnce(new Error("encoder failed"));

    await expect(
      prepareImageFiles([file("one.png"), file("two.png")], [], limits, api),
    ).rejects.toBeInstanceOf(ImageIngestionError);
    expect(api.close).toHaveBeenCalledTimes(2);
    expect(api.revokeObjectURL).toHaveBeenCalledWith("blob:preview-1");
  });

  it("reorders without changing payloads and disposes all preview URLs", () => {
    const images = [prepared("one"), prepared("two"), prepared("three")];
    expect(movePreparedImage(images, 2, -1).map((image) => image.id)).toEqual([
      "one",
      "three",
      "two",
    ]);
    expect(images.map((image) => image.id)).toEqual(["one", "two", "three"]);

    const revoke = vi.fn();
    disposePreparedImages(images, revoke);
    expect(revoke.mock.calls).toEqual([["blob:one"], ["blob:two"], ["blob:three"]]);
  });

  it("exposes an accessible multi-file picker for exactly the supported formats", () => {
    const html = renderToStaticMarkup(createElement(Composer, {
      status: "idle",
      draft: "",
      queue: { steering: [], followUp: [] },
      connected: true,
      imageLimits: limits,
      onDraftChange: vi.fn(),
      onPrompt: vi.fn(async () => undefined),
      onAbort: vi.fn(async () => undefined),
      onError: vi.fn(),
    }));

    expect(html).toContain('type="file"');
    expect(html).toContain('multiple=""');
    expect(html).toContain('accept="image/png,image/jpeg,image/webp"');
    expect(html).toContain('aria-label="Attach images"');
    expect(html).toContain("Attach up to 3 PNG, JPEG, or WebP images.");
  });

  it("renders ordered previews with accessible remove and reorder controls", () => {
    const html = renderToStaticMarkup(createElement(ImagePreviewList, {
      images: [prepared("first"), prepared("second")],
      disabled: false,
      onRemove: vi.fn(),
      onMove: vi.fn(),
    }));

    expect(html).toContain('<ol class="image-preview-list" aria-label="Images attached to prompt">');
    expect(html).toContain('alt="Preview of first.png"');
    expect(html).toContain('aria-label="Remove first.png"');
    expect(html).toContain('aria-label="Move first.png later"');
    expect(html).toContain('aria-label="Move second.png earlier"');
    expect(html.indexOf("first.png")).toBeLessThan(html.indexOf("second.png"));
  });
});
