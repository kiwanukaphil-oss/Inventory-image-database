const UPLOAD_QUEUE_DATABASE = "kline-upload-queue-v1";
const UPLOAD_QUEUE_VERSION = 2;
const PHOTO_STORE = "photos";
const AI_TASK_STORE = "ai-tasks";

let uploadQueueDatabasePromise;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Upload queue request failed."));
  });
}

function transactionFinished(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error("Upload queue transaction was cancelled."));
    transaction.onerror = () => reject(transaction.error || new Error("Upload queue transaction failed."));
  });
}

// Open one shared IndexedDB connection and create the photo store on first use.
// Keeping the connection promise module-scoped avoids opening a new database
// connection for every image in a large intake.
function openUploadQueueDatabase() {
  if (uploadQueueDatabasePromise) return uploadQueueDatabasePromise;
  if (!globalThis.indexedDB) {
    return Promise.reject(new Error("This browser cannot persist an upload queue."));
  }
  uploadQueueDatabasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(UPLOAD_QUEUE_DATABASE, UPLOAD_QUEUE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(PHOTO_STORE)) {
        database.createObjectStore(PHOTO_STORE, { keyPath: "key" });
      }
      if (!database.objectStoreNames.contains(AI_TASK_STORE)) {
        database.createObjectStore(AI_TASK_STORE, { keyPath: "itemId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open the upload queue."));
  });
  return uploadQueueDatabasePromise;
}

// Store the already-compressed photo blob plus its stable item identity. The
// browser can structured-clone Blobs into IndexedDB without base64 expansion.
export async function saveQueuedPhoto(photoRecord) {
  const database = await openUploadQueueDatabase();
  const transaction = database.transaction(PHOTO_STORE, "readwrite");
  transaction.objectStore(PHOTO_STORE).put(photoRecord);
  await transactionFinished(transaction);
}

// Restore photos in their original selection order so a restarted batch still
// has a reliable visual boundary and never depends on the phone gallery order.
export async function loadQueuedPhotos() {
  const database = await openUploadQueueDatabase();
  const transaction = database.transaction(PHOTO_STORE, "readonly");
  const completion = transactionFinished(transaction);
  const records = await requestResult(transaction.objectStore(PHOTO_STORE).getAll());
  await completion;
  return records.sort((left, right) => (left.queueOrder || 0) - (right.queueOrder || 0));
}

export async function deleteQueuedPhoto(key) {
  const database = await openUploadQueueDatabase();
  const transaction = database.transaction(PHOTO_STORE, "readwrite");
  transaction.objectStore(PHOTO_STORE).delete(key);
  await transactionFinished(transaction);
}

export async function clearQueuedPhotos() {
  const database = await openUploadQueueDatabase();
  const transaction = database.transaction(PHOTO_STORE, "readwrite");
  transaction.objectStore(PHOTO_STORE).clear();
  await transactionFinished(transaction);
}

export async function saveQueuedAiTask(taskRecord) {
  const database = await openUploadQueueDatabase();
  const transaction = database.transaction(AI_TASK_STORE, "readwrite");
  transaction.objectStore(AI_TASK_STORE).put(taskRecord);
  await transactionFinished(transaction);
}

export async function loadQueuedAiTasks() {
  const database = await openUploadQueueDatabase();
  const transaction = database.transaction(AI_TASK_STORE, "readonly");
  const completion = transactionFinished(transaction);
  const records = await requestResult(transaction.objectStore(AI_TASK_STORE).getAll());
  await completion;
  return records.sort((left, right) => (left.queueOrder || 0) - (right.queueOrder || 0));
}

export async function deleteQueuedAiTask(itemId) {
  const database = await openUploadQueueDatabase();
  const transaction = database.transaction(AI_TASK_STORE, "readwrite");
  transaction.objectStore(AI_TASK_STORE).delete(itemId);
  await transactionFinished(transaction);
}

// Convert inexpensive image metadata into the preflight label shown on each
// thumbnail. Successful compression is informational, not a capture warning.
export function classifyPhotoQuality({ width, height, originalBytes }) {
  if (!width || !height) {
    return { state: "warn", label: "Check photo", detail: "Could not inspect this file before upload." };
  }
  const aspectRatio = width / height;
  const issues = [];
  const notes = [];
  if (Math.min(width, height) < 900) issues.push("Low resolution");
  if (aspectRatio > 2.2 || aspectRatio < 0.45) issues.push("Extreme crop");
  if (originalBytes < 80_000) issues.push("Tiny file");
  if (originalBytes > 8_000_000) notes.push("Large original compressed");
  if (issues.length) {
    return {
      state: "warn",
      label: issues[0],
      detail: `${width}x${height} · ${[...issues, ...notes].join(" · ")}`,
    };
  }
  return notes.length
    ? { state: "ok", label: "Compressed", detail: `${width}x${height} · ${notes.join(" · ")}` }
    : { state: "ok", label: "Looks ok", detail: `${width}x${height}` };
}

export function preferredUploadConcurrency({ deviceMemory, coarsePointer } = {}) {
  if ((Number(deviceMemory) > 0 && Number(deviceMemory) <= 4) || coarsePointer) return 2;
  return 3;
}

export function isExistingStorageObjectError(error) {
  const status = Number(error?.statusCode || error?.status || 0);
  const message = String(error?.message || error?.error || "").toLowerCase();
  return (status === 400 || status === 409) &&
    (message.includes("already exists") || message.includes("duplicate") || message.includes("resource already"));
}
