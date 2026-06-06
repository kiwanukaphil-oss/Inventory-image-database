// Generate PWA icons (a simple "KL" monogram on the app's dark background)
// into public/. Re-run if the branding changes.
import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
mkdirSync(OUT, { recursive: true });

// `pad` (0–1) shrinks the monogram for maskable icons so it sits inside the
// platform's safe zone.
function svg(size, pad = 0) {
  const inset = size * pad;
  const fontSize = (size - inset * 2) * 0.42;
  const radius = pad ? 0 : size * 0.19; // maskable is full-bleed (no rounded corners)
  return Buffer.from(`
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${size}" height="${size}" rx="${radius}" fill="#0f1115"/>
      <text x="50%" y="50%" text-anchor="middle" dominant-baseline="central"
        font-family="Segoe UI, Roboto, system-ui, sans-serif" font-weight="700"
        font-size="${fontSize}" fill="#4f8cff">KL</text>
    </svg>`);
}

async function png(size, name, pad = 0) {
  await sharp(svg(size, pad)).png().toFile(join(OUT, name));
  console.log("wrote", name);
}

await png(192, "icon-192.png");
await png(512, "icon-512.png");
await png(512, "maskable-512.png", 0.18);
await png(180, "apple-touch-icon.png");
console.log("done");
