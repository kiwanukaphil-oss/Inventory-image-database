// Client-side image compression: resize to a max edge and re-encode as WebP so
// phone photos upload fast and stay small in Storage. Honours EXIF orientation
// so portrait photos aren't rotated. Falls back to the original file if the
// browser can't produce a WebP blob.
export async function compressImage(file, { maxEdge = 1280, quality = 0.8 } = {}) {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();

    const blob = await new Promise((res) => canvas.toBlob(res, "image/webp", quality));
    if (!blob) return { blob: file, ext: file.name.split(".").pop() || "jpg" };
    return { blob, ext: "webp" };
  } catch {
    return { blob: file, ext: file.name.split(".").pop() || "jpg" };
  }
}
