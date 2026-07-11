// Best-effort client error reporting (audit P4). Sends browser errors to the
// Supabase `client_errors` table so field failures on phones aren't invisible.
//
// Hard rule: logging must NEVER cause an error itself — every send is wrapped
// and swallowed. A session-bounded cap + dedupe stop a render loop from
// flooding the table.
import { supabase } from "./db.js";

const MAX_PER_SESSION = 25;
const seenKeys = new Set(); // dedupe identical context+message
let sentCount = 0;

// Never persist query strings or fragments. Supabase auth callbacks and other
// integrations can place short-lived credentials there, and telemetry must not
// become a second credential store.
export function safeTelemetryUrl(value = globalThis.location?.href) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`.slice(0, 1000);
  } catch {
    return null;
  }
}

// Insert one report, respecting the per-session cap and dedupe. Never throws.
async function postError({ context, message, stack, severity = "error" }) {
  if (sentCount >= MAX_PER_SESSION) return;
  const key = `${context}|${message}`.slice(0, 200);
  if (seenKeys.has(key)) return;
  seenKeys.add(key);
  sentCount++;
  try {
    await supabase.from("client_errors").insert({
      context: context || null,
      message: (message || "").slice(0, 2000),
      stack: stack ? String(stack).slice(0, 8000) : null,
      url: safeTelemetryUrl(),
      user_agent: navigator.userAgent,
      severity,
    });
  } catch {
    /* never let logging surface an error */
  }
}

// Report a caught error from a known site (e.g. the app's top-level catch).
export function reportError(context, err) {
  postError({ context, message: err?.message || String(err), stack: err?.stack });
}

// Register window-level handlers once, for errors no try/catch caught.
let installed = false;
export function installGlobalErrorHandlers() {
  if (installed) return;
  installed = true;
  window.addEventListener("error", (e) => {
    postError({ context: "window.onerror", message: e?.message || "error", stack: e?.error?.stack });
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e?.reason;
    postError({
      context: "unhandledrejection",
      message: reason?.message || String(reason),
      stack: reason?.stack,
    });
  });
}
