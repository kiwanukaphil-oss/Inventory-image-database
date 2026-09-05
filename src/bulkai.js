import { resolveFields, categoryPath } from "./data.js";
import { esc, trapFocus, isTopOverlay } from "./ui.js";
import { extractCatalogItemWithAi } from "./catalogAi.js";
import { isRailwayCatalogMode } from "./railwayCatalogConfig.js";
import { canRunCatalogAi } from "./lib/railway-catalog-ui.js";

// Bulk AI fill: run the active catalog AI backend across a set of items (the
// gallery's currently-filtered rows), filling empty fields with AI suggestions.
// Safe by default — only blank fields are written, existing values are never
// overwritten; every change is audited and carries a confidence dot.

const CONCURRENCY = 2; // keep Anthropic vision calls below overload-prone bursts
/**
 * Open the bulk-AI modal for the given items.
 * @param {Array} items  item rows (need id, category_id, attributes, brand, image_path, status)
 * @param {object} caps  capability object (Railway AI grant or legacy edit grant)
 * @param {Function} onDone called after the run (to refresh the gallery)
 */
export function openBulkAi(items, caps, onDone) {
  if (!canRunCatalogAi(caps, isRailwayCatalogMode)) return;
  const withImages = items.filter((it) => it.image_path);
  const n = withImages.length;
  const LARGE = 25; // above this, require an explicit acknowledgement
  const isLarge = n > LARGE;

  const modal = document.createElement("div");
  modal.className = "bulkai";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-label", `AI-fill ${n} item${n === 1 ? "" : "s"}`);
  modal.innerHTML = `
    <div class="bulkai-panel">
      <div id="confirmStep">
        <h2>AI-fill ${n} item${n === 1 ? "" : "s"}</h2>
        <p class="sub">Reads each photo's tags and fills <b>empty</b> fields with AI suggestions
          (with confidence), for you to review. Existing values are not changed.</p>
        <label class="chk"><input type="checkbox" id="onlyEmpty" checked> Only fill empty fields</label>
        <p class="note">${items.length - n > 0
          ? `${items.length - n} item(s) without a photo will be skipped.` : ""}
          Runs on the ${n} currently-filtered item(s) with photos. Cost is ~a fraction of a cent each.</p>
        ${isLarge
          ? `<div class="bulkai-warn">⚠️ This will run AI on <b>${n}</b> items at once
               (~${Math.ceil((n * 2.5) / 60)} min). Tip: filter the gallery first to target a smaller set.</div>
             <label class="chk"><input type="checkbox" id="ackBig"> Yes, run AI on all ${n} items</label>`
          : ""}
        <div class="bulkai-actions">
          <button class="ghost" id="cancelBtn">Cancel</button>
          <button class="primary" id="startBtn" ${n && !isLarge ? "" : "disabled"}>Start</button>
        </div>
      </div>
      <div id="runStep" style="display:none">
        <h2>Filling…</h2>
        <div class="bulkai-bar"><div id="barFill"></div></div>
        <div class="bulkai-stats" id="stats" aria-live="polite"></div>
        <div class="bulkai-log" id="log" role="log" aria-live="polite"></div>
        <div class="bulkai-actions">
          <button class="danger" id="stopBtn">Stop</button>
          <button class="primary" id="closeBtn" style="display:none">Done</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);
  const releaseFocus = trapFocus(modal);
  requestAnimationFrame(() => modal.querySelector("#startBtn")?.focus());

  // confirm → running → done. Gates how the modal may be dismissed: a backdrop
  // tap mid-run used to remove the modal while the workers kept writing items
  // headlessly — no progress, no refresh. Now a running batch can only be ended
  // via Stop, and a dismissal after the run still triggers the gallery refresh.
  let phase = "confirm";
  const close = () => { releaseFocus(); document.removeEventListener("keydown", onKey); modal.remove(); };
  const dismiss = () => {
    if (phase === "running") return; // use Stop — never orphan a run in flight
    close();
    if (phase === "done") onDone?.();
  };
  const onKey = (e) => { if (e.key === "Escape" && isTopOverlay(modal)) dismiss(); };
  document.addEventListener("keydown", onKey);
  modal.querySelector("#cancelBtn").onclick = dismiss;
  modal.addEventListener("click", (e) => { if (e.target === modal) dismiss(); });

  // For large batches, Start stays disabled until the user acknowledges.
  const ack = modal.querySelector("#ackBig");
  if (ack) ack.onchange = () => { modal.querySelector("#startBtn").disabled = !ack.checked; };

  modal.querySelector("#startBtn").onclick = () => {
    const onlyEmpty = modal.querySelector("#onlyEmpty").checked;
    modal.querySelector("#confirmStep").style.display = "none";
    modal.querySelector("#runStep").style.display = "block";
    phase = "running";
    runBatch(modal, withImages, onlyEmpty, onDone, close, () => { phase = "done"; });
  };
}

async function runBatch(modal, items, onlyEmpty, onDone, close, onFinished) {
  const total = items.length;
  let done = 0, filled = 0, skipped = 0, failed = 0;
  let stopped = false;

  const bar = modal.querySelector("#barFill");
  const statsEl = modal.querySelector("#stats");
  const logEl = modal.querySelector("#log");
  const stopBtn = modal.querySelector("#stopBtn");
  const closeBtn = modal.querySelector("#closeBtn");

  stopBtn.onclick = () => { stopped = true; stopBtn.disabled = true; stopBtn.textContent = "Stopping…"; };

  function paint() {
    bar.style.width = `${Math.round((done / total) * 100)}%`;
    statsEl.innerHTML =
      `${done}/${total} processed · <b>${filled}</b> filled · ${skipped} skipped${failed ? ` · <span style="color:var(--flag-txt)">${failed} failed</span>` : ""}`;
  }
  function logLine(html) {
    const div = document.createElement("div");
    div.innerHTML = html;
    logEl.prepend(div);
    while (logEl.childElementCount > 40) logEl.lastChild.remove();
  }
  paint();

  async function processItem(it) {
    const label = esc(it.brand || it.name || it.id.slice(0, 6));
    try {
      const defs = [
        { key: "brand", label: "Brand" },
        { key: "name", label: "Product name" },
        ...resolveFields(it.category_id).map((f) => ({
          key: f.key, label: f.label, type: f.type, options: f.options, vocab: f.vocab,
        })),
      ];
      const data = await extractCatalogItemWithAi({
        itemId: it.id,
        category: categoryPath(it.category_id),
        fields: defs,
        branchId: it.branch_id,
      });

      const appliedCount = data.applied_fields?.length || 0;
      if (appliedCount > 0) {
        filled++;
        logLine(`âœ“ ${label} â€” filled ${appliedCount} field${appliedCount === 1 ? "" : "s"}`);
      } else {
        skipped++;
        logLine(`Â· ${label} â€” nothing to fill`);
      }
    } catch (e) {
      failed++;
      console.error("Railway catalog AI fill failed", it.id, e);
      logLine(`<span style="color:var(--flag-txt)">✕ ${label} — ${esc(e?.message || e)}</span>`);
    } finally {
      done++;
      paint();
    }
  }

  // Concurrency-limited queue.
  const queue = [...items];
  async function worker() {
    while (queue.length && !stopped) await processItem(queue.shift());
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  onFinished?.(); // the modal may be dismissed again (and will refresh on close)
  modal.querySelector("#runStep h2").textContent = stopped ? "Stopped" : "Done";
  if (!stopped) navigator.vibrate?.([12, 40, 12]); // affirmative "batch done" buzz
  stopBtn.style.display = "none";
  closeBtn.style.display = "inline-block";
  closeBtn.onclick = () => { close(); onDone?.(); };
}
