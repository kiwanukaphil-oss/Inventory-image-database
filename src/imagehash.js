// Tiny perceptual image hash (dHash) for catching accidental double-captures in
// a burst session. Downscales to 9×8 grayscale and records, per row, whether
// each pixel is darker than its right neighbour — 64 bits robust to small
// exposure/scale shifts. Compared with a Hamming distance.
//
// NB: this can't tell "same physical unit shot twice" from "two identical
// units" — visually they're the same. Callers must add a time/recency gate so
// the guard only fires on plausibly-accidental repeats (see upload.js), never on
// the deliberate next identical unit the one-photo-one-unit rule expects.

export function dHash(sourceCanvas) {
  const w = 9, h = 8;
  const tmp = document.createElement("canvas");
  tmp.width = w; tmp.height = h;
  const ctx = tmp.getContext("2d");
  ctx.drawImage(sourceCanvas, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const gray = (i) => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  const bits = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w - 1; x++) {
      const i = (y * w + x) * 4, j = (y * w + x + 1) * 4;
      bits.push(gray(i) < gray(j) ? 1 : 0);
    }
  }
  let hex = "";
  for (let k = 0; k < bits.length; k += 4) {
    hex += ((bits[k] << 3) | (bits[k + 1] << 2) | (bits[k + 2] << 1) | bits[k + 3]).toString(16);
  }
  return hex; // 16 hex chars = 64 bits
}

// Hamming distance between two dHash hex strings (0 = identical, 64 = opposite).
export function hammingHex(a, b) {
  if (!a || !b || a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}
