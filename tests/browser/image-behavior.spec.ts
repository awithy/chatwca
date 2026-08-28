import { deflateSync } from "node:zlib";

import { expect, test, type Page } from "@playwright/test";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(data: Buffer): number {
  let crc = 0xffff_ffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
}

/** Create a compact, deterministic true-color PNG without image fixture dependencies. */
function solidPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;

  const rowBytes = width * 3;
  const pixels = Buffer.alloc((rowBytes + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const offset = row * (rowBytes + 1);
    pixels[offset] = 0;
    pixels.fill(0x35, offset + 1, offset + rowBytes + 1);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

async function attachThroughDomEvent(
  page: Page,
  kind: "paste" | "drop",
  name: string,
  bytes: Buffer,
): Promise<void> {
  const base64 = bytes.toString("base64");
  const target = kind === "paste"
    ? page.getByRole("textbox", { name: "Message" })
    : page.locator(".composer");

  await target.evaluate((element, input) => {
    const binary = atob(input.base64);
    const data = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      data[index] = binary.charCodeAt(index);
    }
    const transfer = new DataTransfer();
    transfer.items.add(new File([data], input.name, { type: "image/png" }));
    const event = input.kind === "paste"
      ? new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: transfer,
        })
      : new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        });
    element.dispatchEvent(event);
  }, { kind, name, base64 });
}

test("paste, drop, selection, removal, resizing, and image submission", async ({ page }) => {
  const smallImage = solidPng(32, 16);
  const oversizedDimensions = solidPng(3000, 1000);

  await page.goto("/");
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Image behavior/ }).click();
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect(composer).toBeEnabled();

  const picker = page.getByLabel("Choose PNG, JPEG, or WebP images");
  await picker.setInputFiles({
    name: "wide.png",
    mimeType: "image/png",
    buffer: oversizedDimensions,
  });
  await expect(page.getByRole("img", { name: "Preview of wide.png" })).toBeVisible();
  await expect(page.locator(".image-preview-details")).toContainText("2048 × 683");

  await page.getByRole("button", { name: "Remove wide.png" }).click();
  await expect(page.getByRole("img", { name: "Preview of wide.png" })).toHaveCount(0);

  await attachThroughDomEvent(page, "paste", "pasted.png", smallImage);
  await expect(page.getByRole("img", { name: "Preview of pasted.png" })).toBeVisible();
  await page.getByRole("button", { name: "Remove pasted.png" }).click();

  await attachThroughDomEvent(page, "drop", "dropped.png", smallImage);
  await expect(page.getByRole("img", { name: "Preview of dropped.png" })).toBeVisible();
  await page.getByRole("button", { name: "Remove dropped.png" }).click();

  await picker.setInputFiles({
    name: "submitted.png",
    mimeType: "image/png",
    buffer: oversizedDimensions,
  });
  await expect(page.locator(".image-preview-details")).toContainText("2048 × 683");
  await composer.fill("Describe this resized image");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.locator(".image-preview-list")).toHaveCount(0);
  const submittedMessage = page.locator(".chat-message.message-user").last();
  await expect(submittedMessage).toContainText("Describe this resized image");
  await expect(submittedMessage).toContainText("submitted.png");
});
