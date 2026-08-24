export const DEFAULT_GALLERY_RENDER_BATCH_SIZE = 60;

export function initialGalleryRenderLimit(totalItems, batchSize = DEFAULT_GALLERY_RENDER_BATCH_SIZE) {
  return Math.min(Math.max(0, totalItems), Math.max(1, batchSize));
}

export function nextGalleryRenderLimit(currentLimit, totalItems, batchSize = DEFAULT_GALLERY_RENDER_BATCH_SIZE) {
  const safeCurrentLimit = Math.max(0, currentLimit);
  const safeBatchSize = Math.max(1, batchSize);
  return Math.min(Math.max(0, totalItems), safeCurrentLimit + safeBatchSize);
}
