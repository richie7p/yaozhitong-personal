/** Validate original image bytes without transforming or downsampling the photo. */
export async function recognitionPhotoType(
  photo: Blob,
): Promise<"image/jpeg" | "image/png"> {
  if (!photo.size) throw new Error("這張照片是空的，請重新選擇或拍攝。");
  if (photo.size > 8_000_000)
    throw new Error(
      "照片超過 8 MB，請改選較小的 JPEG 或 PNG 照片，或降低拍攝解析度後重拍。",
    );
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await photo.slice(0, 8).arrayBuffer());
  } catch {
    throw new Error("無法讀取這張照片，請重新選擇或拍攝。");
  }
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v))
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  throw new Error(
    "請選擇 JPEG 或 PNG 照片；HEIC 等格式請先另存為 JPEG，再重新選取。",
  );
}
