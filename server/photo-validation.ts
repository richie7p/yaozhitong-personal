import sharp from "sharp";
import { fail } from "./config.js";

export const MAX_PHOTO_BYTES = 8_000_000;
// Includes common 12 MP and 24 MP phone photos. A decoded 8-bit RGBA frame
// stays at or below 128 MB; only one decode per web process may run at a time.
export const MAX_PHOTO_PIXELS = 32_000_000;
let activeDecodes = 0;

function completePngChunks(data: Buffer) {
  let offset = 8;
  let hasPixels = false;
  while (offset <= data.length - 12) {
    const length = data.readUInt32BE(offset);
    // Check subtraction before adding an untrusted unsigned chunk length.
    if (length > data.length - offset - 12) return false;
    const type = data.toString("latin1", offset + 4, offset + 8);
    if (offset === 8 && (type !== "IHDR" || length !== 13)) return false;
    if (type === "IEND")
      return (
        length === 0 &&
        hasPixels &&
        offset + 12 === data.length &&
        data.readUInt32BE(offset + 8) === 0xae426082
      );
    if (type === "IDAT") hasPixels = true;
    offset += length + 12;
  }
  return false;
}

/** Fully decode untrusted pixels, without changing the original uploaded photo. */
export async function validateRecognitionPhoto(
  data: Buffer,
  mediaType: "image/jpeg" | "image/png",
) {
  if (!data.length || data.length > MAX_PHOTO_BYTES)
    return fail("invalid_image", "請上傳 8 MB 以內的 JPEG 或 PNG 圖片。");
  const signatureMatches =
    mediaType === "image/png"
      ? data
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : data[0] === 255 && data[1] === 216 && data[2] === 255;
  if (!signatureMatches)
    return fail("invalid_image", "請上傳有效的 JPEG 或 PNG 圖片。");
  // libpng can decode complete pixels even if the final IEND is truncated.
  // Walk chunk boundaries so a forged IEND byte suffix inside a chunk is not
  // mistaken for the end of a structurally complete PNG file.
  if (mediaType === "image/png" && !completePngChunks(data))
    return fail("invalid_image", "PNG 圖片不完整，請重新另存或選取照片。");
  if (activeDecodes)
    return fail("image_busy", "目前照片檢查較忙，請稍後重新送出。", 429);
  activeDecodes++;
  try {
    const image = sharp(data, {
      failOn: "warning",
      limitInputPixels: MAX_PHOTO_PIXELS,
      limitInputChannels: 4,
      sequentialRead: true,
    });
    const metadata = await image.metadata();
    if (
      metadata.format !== (mediaType === "image/jpeg" ? "jpeg" : "png") ||
      !metadata.width ||
      !metadata.height ||
      metadata.width * metadata.height > MAX_PHOTO_PIXELS ||
      (metadata.pages || 1) !== 1
    )
      return fail(
        "invalid_image",
        "請上傳有效的單張 JPEG 或 PNG 圖片，解析度須在 3,200 萬畫素以內。",
      );
    // metadata() alone does not read image pixels. Force a complete decode so
    // truncated/corrupt streams cannot reach Storage or a paid AI request.
    await image.raw({ depth: "uchar" }).toBuffer();
  } catch {
    return fail(
      "invalid_image",
      "照片格式或內容無法讀取，請另存為完整的 JPEG 或 PNG 再試；解析度須在 3,200 萬畫素以內。",
    );
  } finally {
    activeDecodes--;
  }
}
