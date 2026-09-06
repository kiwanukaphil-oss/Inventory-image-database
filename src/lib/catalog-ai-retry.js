const DEFAULT_MAX_ATTEMPTS = 4;
const MAX_RETRY_DELAY_MS = 30_000;
const NETWORK_RETRY_BASE_MS = 1_500;
const RATE_LIMIT_RETRY_BASE_MS = 10_000;
const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const NETWORK_ERROR_PATTERN = /failed to fetch|network(?:error| request failed)|load failed|could not reach/i;

export function isRetryableCatalogAiError(error) {
  const status = Number(error?.status || 0);
  return status === 0
    ? NETWORK_ERROR_PATTERN.test(String(error?.message || ""))
    : RETRYABLE_HTTP_STATUSES.has(status);
}

export function catalogAiRetryDelayMs(error, failedAttempt, randomValue = Math.random()) {
  const status = Number(error?.status || 0);
  const baseDelay = status === 429 ? RATE_LIMIT_RETRY_BASE_MS : NETWORK_RETRY_BASE_MS;
  const exponentialDelay = baseDelay * (2 ** Math.max(0, failedAttempt - 1));
  const jitterMultiplier = 1 + (Math.max(0, Math.min(1, randomValue)) * 0.2);
  const serverDelay = Math.max(0, Number(error?.retryAfterMs) || 0);
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(serverDelay, Math.round(exponentialDelay * jitterMultiplier)));
}

// Retry waits are split into short slices so Stop and the shared circuit breaker
// remain responsive even during a long rate-limit delay.
export async function waitForCatalogAiRetry(delayMs, shouldContinue = () => true) {
  const deadline = Date.now() + Math.max(0, delayMs);
  while (Date.now() < deadline) {
    if (!shouldContinue()) return false;
    const remainingMs = deadline - Date.now();
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, remainingMs)));
  }
  return shouldContinue();
}

// A retryable transport/service error is attempted a bounded number of times.
// The original error is rethrown with attempt metadata so the batch can decide
// whether to open its circuit breaker without losing the server's message.
export async function runCatalogAiWithRetry(operation, options = {}) {
  const {
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    onRetry = () => {},
    random = Math.random,
    shouldContinue = () => true,
    wait = waitForCatalogAiRetry,
  } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      error.catalogAiAttempts = attempt;
      const canRetry = attempt < maxAttempts && isRetryableCatalogAiError(error);
      if (!canRetry || !shouldContinue()) throw error;

      const delayMs = catalogAiRetryDelayMs(error, attempt, random());
      onRetry({ attempt, delayMs, error, maxAttempts, nextAttempt: attempt + 1 });
      const completedWait = await wait(delayMs, shouldContinue);
      if (!completedWait || !shouldContinue()) {
        error.catalogAiRetryCancelled = true;
        throw error;
      }
    }
  }

  throw new Error("Catalog AI retry loop ended unexpectedly.");
}
