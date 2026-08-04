// Client-side image compression: resize to a max edge and re-encode as WebP so
// phone photos upload fast and stay small in Storage. Honours EXIF orientation
// so portrait photos aren't rotated. Falls back to the original file if the
// browser can't produce a WebP blob — but flags it `oversize` if that original
// is implausibly large (audit R6), so the caller can reject rather than silently
// upload a 10MB+ photo.
const DEFAULT_MAX_FALLBACK_BYTES = 10 * 1024 * 1024; // 10 MB

function fallback(file, maxBytes, dimensions = {}) {
  return {
    blob: file,
    ext: file.name.split(".").pop() || "jpg",
    oversize: file.size > maxBytes,
    sourceWidth: dimensions.sourceWidth || 0,
    sourceHeight: dimensions.sourceHeight || 0,
  };
}

export async function compressImage(
  file,
  { maxEdge = 1280, quality = 0.8, maxFallbackBytes = DEFAULT_MAX_FALLBACK_BYTES } = {},
) {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const sourceWidth = bitmap.width;
    const sourceHeight = bitmap.height;
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();

    const blob = await new Promise((res) => canvas.toBlob(res, "image/webp", quality));
    if (!blob) return fallback(file, maxFallbackBytes, { sourceWidth, sourceHeight });
    return { blob, ext: "webp", oversize: false, sourceWidth, sourceHeight };
  } catch {
    return fallback(file, maxFallbackBytes);
  }
}
