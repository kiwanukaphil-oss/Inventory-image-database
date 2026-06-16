import { supabase } from "./db.js";
import { openEditor } from "./editor.js";
import { loadSyncCounts } from "./syncstate.js";
import { openBottomSheet, toast } from "./ui.js";

// The Sync Center (⋮ → Shop sync): the one place the Catalog↔POS integration
// is visible as a system. Deliberately NOT a tab — staff shouldn't think about
// sync; the people who fix it know where it lives. Three sections:
//   Health   — the last run of each loop (push / mirror / reconcile), with a
//              loud warning when the mirror hasn't checked in (silence = broken)
//   Queue    — live counts per sync state, so "is everything in the shop?" is
//              one glance
//   Problems — items in error with their reason, plus any drift the nightly
//              reconcile found
// "Sync now" buttons invoke the edge functions directly with the signed-in
// admin's JWT (the functions authorize admins/user-managers themselves).

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

const FUNCTIONS_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

/** "3 min ago" / "2 h ago" — terse, for the health rows. */
function ago(iso) {
  if (!iso) return "never";
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** Invoke an edge function as the signed-in user; returns the parsed body. */
async function invokeLoop(name) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Not signed in");
  const res = await fetch(`${FUNCTIONS_BASE}/${name}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${name} failed (${res.status})`);
  return body;
}

/** Everything the sheet shows, fetched fresh each render. */
async function loadState() {
  const lastRunOf = async (kind) => {
    const { data } = await supabase
      .from("pos_sync_runs")
      .select("finished_at, ok, ok_count, error_count, error, summary")
      .eq("kind", kind)
      .order("started_at", { ascending: false })
      .limit(1);
    return (data || [])[0] || null;
  };
  const [push, mirror, reconcile, counts, errorItems] = await Promise.all([
    lastRunOf("push"),
    lastRunOf("mirror"),
    lastRunOf("reconcile"),
    // Counts come from the shared single source (syncstate.js) — same predicates
    // the Shop strip uses, so the two surfaces never disagree.
    loadSyncCounts(["queued", "sending", "errors", "dirty"]),
    supabase
      .from("items")
      .select("id, sku, brand, name, pos_sync_error")
      .eq("pos_sync_status", "error")
      .limit(20)
      .then((r) => r.data || []),
  ]);
  return { push, mirror, reconcile, ...counts, errorItems };
}

export function openSyncCenter(caps, onChanged, opts = {}) {
  const sh = openBottomSheet("Shop sync", `<div class="muted" style="padding:14px">Loading…</div>`);

  async function render() {
    let s;
    try {
      s = await loadState();
    } catch (e) {
      sh.body.innerHTML = `<div class="muted" style="padding:14px">Couldn't load sync state: ${esc(e.message)}</div>`;
      return;
    }

    const runRow = (label, run, staleAfterMin) => {
      if (!run) return `<div class="sync-row"><span>${label}</span><span class="sync-val muted">never ran</span></div>`;
      const mins = (Date.now() - new Date(run.finished_at).getTime()) / 60000;
      const bad = run.ok === false;
      const stale = staleAfterMin && mins > staleAfterMin;
      const mark = bad ? "⚠ failed" : stale ? "⚠ overdue" : "✓";
      return `<div class="sync-row"><span>${label}</span>
        <span class="sync-val${bad || stale ? " warn" : ""}" ${run.error ? `title="${esc(run.error)}"` : ""}>${mark} · ${ago(run.finished_at)}</span></div>`;
    };

    const countRow = (label, n, warn) =>
      `<div class="sync-row"><span>${label}</span><span class="sync-val${warn && n ? " warn" : ""}">${n}</span></div>`;

    // Drift findings from the nightly reconcile (Phase 4) — only shown when present.
    const findings = s.reconcile?.summary?.findings || [];
    const driftHtml = findings.length
      ? `<div class="sheet-sec">Drift report</div>
         ${findings.slice(0, 12).map((f) => `<div class="sync-problem"><b>${esc(f.sku || f.kind)}</b> — ${esc(f.note)}</div>`).join("")}`
      : "";

    const focusProblems = opts.focus === "errors";
    const problemsHtml = s.errorItems.length
      ? `<div class="sheet-sec${focusProblems ? " sync-focus-title" : ""}">Problems</div>
         ${s.errorItems.map((it) => `<div class="sync-problem sync-problem-row">
           <div><b>${esc(it.brand || it.name || "—")} · ${esc(it.sku || "no SKU")}</b><br>
             <span class="muted">${esc(it.pos_sync_error || "unknown error")}</span></div>
           <button class="ghost sync-open" data-open-item="${esc(it.id)}">Open</button>
         </div>`).join("")}
         <button class="ghost up-go" id="syncRetryErrors">Retry shop issues now</button>
         <div class="menu-sub" style="margin-top:4px">Retry runs the shop push and keeps failures here until fixed.</div>`
      : "";

    sh.body.innerHTML = `
      <div class="sheet-sec">Health</div>
      ${runRow("Send to shop (push)", s.push, 0)}
      ${runRow("Shop numbers (mirror)", s.mirror, 30)}
      ${runRow("Drift check (reconcile)", s.reconcile, 0)}
      <div class="sheet-sec">Queue</div>
      ${countRow("Waiting to go to the shop", s.queued)}
      ${countRow("Sending / awaiting POS approval", s.sending)}
      ${countRow("Edits not yet in the shop", s.dirty)}
      ${countRow("Errors", s.errors, true)}
      ${problemsHtml}
      ${driftHtml}
      <button class="primary up-go" id="syncPush" style="margin-top:12px">Send to shop now</button>
      <button class="ghost" id="syncMirror" style="margin-top:8px">Refresh shop numbers</button>`;

    const runBtn = (id, fn, doneMsg) => {
      const btn = sh.body.querySelector(id);
      if (!btn) return;
      btn.onclick = async () => {
        btn.disabled = true;
        const old = btn.textContent;
        btn.textContent = "Running…";
        try {
          const r = await invokeLoop(fn);
          toast(doneMsg(r));
          onChanged?.();
        } catch (e) {
          toast(`Sync failed: ${e.message}`);
        }
        btn.disabled = false;
        btn.textContent = old;
        render(); // counts and health just changed
      };
    };
    sh.body.querySelectorAll("[data-open-item]").forEach((btn) => {
      btn.onclick = () => {
        const id = btn.dataset.openItem;
        sh.close();
        openEditor(id, caps, onChanged, { focusIssue: "sync" });
      };
    });
    runBtn("#syncPush", "pos-push", (r) =>
      `Sent — ${r.created || 0} new, ${r.add_variant || 0} sizes, ${r.add_stock || 0} stock, ${r.dirty_updated || 0} updates${r.errored ? `, ${r.errored} errors` : ""}`);
    runBtn("#syncRetryErrors", "pos-push", (r) =>
      `Sent — ${r.created || 0} new, ${r.add_variant || 0} sizes, ${r.add_stock || 0} stock, ${r.dirty_updated || 0} updates${r.errored ? `, ${r.errored} errors` : ""}`);
    runBtn("#syncMirror", "pos-mirror", (r) => `Shop numbers refreshed (${r.variants} products)`);
  }

  render();
}
