// ============================================================================
//  Calibration report — does the AI's per-field confidence predict correctness?
//
//  Reads existing production data (items.confidence + audit_log corrections) and
//  measures, per confidence level (High/Medium/Low), how often a human later
//  CHANGED that field. Well-calibrated = High rarely corrected, Low often.
//
//  This is the de-risking step before trusting "Approve all high-confidence":
//  if High-confidence fields are almost never corrected, batch approval is safe;
//  if they're corrected often, the confidence signal can't be trusted blindly.
//
//  Read-only. Uses the service-role key for an admin-side read (RLS-bypassing),
//  exactly like scripts/seed.mjs. Never shipped to the browser.
//
//  Run with:  node --env-file=.env scripts/calibration_report.mjs
// ============================================================================

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// Fields that audit_log/confidence may both reference but that are NOT
// AI-descriptive judgments (price/stock are human-entered regardless), so they
// must not pollute the calibration of how well the AI "reads" a photo.
const NON_AI_FIELDS = new Set(["price", "stock_quantity", "reorder_level", "status"]);

const LEVELS = ["High", "Medium", "Low"];
const pct = (num, den) => (den === 0 ? "  —  " : `${((100 * num) / den).toFixed(1)}%`);
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

// Pull every page of a table (Supabase caps at 1000 rows/request). When
// `optional`, a missing table (e.g. calibration_marks before its migration is
// applied) yields [] instead of aborting the whole report.
async function fetchAll(table, columns, optional = false) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select(columns).range(from, from + 999);
    if (error) {
      if (optional) return [];
      console.error(`Error reading ${table}:`, error.message);
      process.exit(1);
    }
    rows.push(...data);
    if (data.length < 1000) break;
  }
  return rows;
}

// Ground-truth report from the manual calibration_marks table (the gold
// standard): direct correct/wrong verdicts a human recorded per field, bucketed
// by the AI's confidence at mark time. Printed first when any marks exist.
function reportGroundTruth(marks) {
  if (!marks.length) {
    console.log("\n=== GROUND-TRUTH CALIBRATION (manual marks) ====================");
    console.log("No calibration_marks yet — run the in-app Calibration check first.");
    return;
  }
  const byLevel = Object.fromEntries(LEVELS.map((l) => [l, { total: 0, correct: 0 }]));
  const byField = {};
  for (const m of marks) {
    if (!LEVELS.includes(m.ai_level)) continue;
    byLevel[m.ai_level].total++;
    const f = (byField[m.field] = byField[m.field] || Object.fromEntries(LEVELS.map((l) => [l, { total: 0, correct: 0 }])));
    f[m.ai_level].total++;
    if (m.verdict === "correct") { byLevel[m.ai_level].correct++; f[m.ai_level].correct++; }
  }
  console.log("\n=== GROUND-TRUTH CALIBRATION (manual marks) ====================");
  console.log("(Accuracy = fields a human confirmed correct, per confidence level.)");
  console.log(`${pad("Level", 8)}${padL("Fields", 8)}${padL("Correct", 9)}${padL("Accuracy", 10)}`);
  for (const l of LEVELS) {
    const b = byLevel[l];
    console.log(`${pad(l, 8)}${padL(b.total, 8)}${padL(b.correct, 9)}${padL(pct(b.correct, b.total), 10)}`);
  }
  const h = byLevel.High;
  console.log("\n--- Read on High-confidence ---");
  if (h.total < 10) console.log(`Only ${h.total} High marks — calibrate more items to conclude.`);
  else if (h.correct / h.total >= 0.95) console.log(`High accuracy ${pct(h.correct, h.total)} — batch-approving all-High items is reasonable (keep Undo).`);
  else console.log(`High accuracy ${pct(h.correct, h.total)} — too low to blind-approve; keep a human glance.`);
}

async function main() {
  const items = await fetchAll("items", "id, status, confidence, attributes, created_at");
  const audits = await fetchAll("audit_log", "item_id, change_type, field, before, after, created_at");
  const marks = await fetchAll("calibration_marks", "item_id, field, ai_level, verdict", true);

  reportGroundTruth(marks);

  // ---- index human corrections: set of "itemId|field" that were ever edited ----
  // An 'edit' audit row only exists when before IS DISTINCT FROM after, so its
  // mere presence means the field's value was changed after creation.
  const correctedFields = new Set();   // `${item_id}|${field}`
  const itemHasAnyEdit = new Set();    // item_id with ≥1 descriptive-field edit
  for (const a of audits) {
    if (a.change_type !== "edit" || !a.field) continue;
    if (NON_AI_FIELDS.has(a.field)) continue;
    correctedFields.add(`${a.item_id}|${a.field}`);
    itemHasAnyEdit.add(a.item_id);
  }

  // ---- dataset overview ----
  const statusCounts = {};
  let withConfidence = 0;
  for (const it of items) {
    statusCounts[it.status] = (statusCounts[it.status] || 0) + 1;
    if (it.confidence && Object.keys(it.confidence).length) withConfidence++;
  }

  // "Verified" = a human reached a verdict on the item. Approved/flag are the
  // states a reviewer sets; an item still in draft/needs-review hasn't been
  // judged, so its untouched fields tell us nothing about correctness.
  const verified = items.filter((it) => it.status === "approved" || it.status === "flag");

  console.log("\n=== DATASET OVERVIEW ===========================================");
  console.log(`Total items:            ${items.length}`);
  console.log(`  with confidence data: ${withConfidence}`);
  console.log(`Status:                 ${Object.entries(statusCounts).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  console.log(`Verified (approved/flag): ${verified.length}   <- calibration is measured on these`);
  console.log(`Audit edit rows (descriptive fields): ${correctedFields.size}`);

  if (verified.length === 0) {
    console.log("\nNo human-verified items yet — calibration can't be measured from corrections.");
    console.log("Recommend a manual calibration sample instead (see notes at the end).");
    return;
  }

  // ---- core calibration: correction rate by confidence level ----
  // For every (verified item, field with a confidence stamp), did a human later
  // change that field? Bucket the answer by the AI's confidence level.
  const byLevel = Object.fromEntries(LEVELS.map((l) => [l, { total: 0, corrected: 0 }]));
  const byField = {}; // field -> { High:{total,corrected}, Medium:..., Low:... }

  for (const it of verified) {
    const conf = it.confidence || {};
    for (const [field, level] of Object.entries(conf)) {
      if (!LEVELS.includes(level) || NON_AI_FIELDS.has(field)) continue;
      const wasCorrected = correctedFields.has(`${it.id}|${field}`);
      byLevel[level].total++;
      if (wasCorrected) byLevel[level].corrected++;
      const f = (byField[field] = byField[field] || Object.fromEntries(LEVELS.map((l) => [l, { total: 0, corrected: 0 }])));
      f[level].total++;
      if (wasCorrected) f[level].corrected++;
    }
  }

  console.log("\n=== PROXY CALIBRATION (audit-log corrections, fallback) ========");
  console.log("(Used before manual marks exist; higher rate = more often wrong.)");
  console.log(`${pad("Level", 8)}${padL("Fields", 8)}${padL("Corrected", 11)}${padL("Rate", 8)}`);
  for (const l of LEVELS) {
    const b = byLevel[l];
    console.log(`${pad(l, 8)}${padL(b.total, 8)}${padL(b.corrected, 11)}${padL(pct(b.corrected, b.total), 8)}`);
  }

  // Verdict heuristic on the all-important High bucket.
  const high = byLevel.High;
  const highRate = high.total ? high.corrected / high.total : null;
  console.log("\n--- Read on High-confidence (the batch-approve candidate) ---");
  if (high.total < 30) {
    console.log(`Only ${high.total} High-confidence field-instances verified — too few to trust a rate yet.`);
  } else if (highRate <= 0.02) {
    console.log(`High-confidence correction rate ${pct(high.corrected, high.total)} — strong. Batch-approve of all-High items looks safe (keep an Undo).`);
  } else if (highRate <= 0.05) {
    console.log(`High-confidence correction rate ${pct(high.corrected, high.total)} — borderline. Batch-approve is defensible with Undo + spot-checks.`);
  } else {
    console.log(`High-confidence correction rate ${pct(high.corrected, high.total)} — too high to blind-approve. Keep a human glance in the loop.`);
  }

  // ---- per-field breakdown: which fields the AI gets wrong most ----
  // Directly feeds the "show WHICH field is doubtful in the queue" idea.
  console.log("\n=== PER-FIELD correction rate (verified items) =================");
  console.log(`${pad("Field", 16)}${LEVELS.map((l) => padL(l, 12)).join("")}`);
  const fieldRows = Object.entries(byField).sort((a, b) => {
    const ra = a[1].High.total ? a[1].High.corrected / a[1].High.total : -1;
    const rb = b[1].High.total ? b[1].High.corrected / b[1].High.total : -1;
    return rb - ra;
  });
  for (const [field, f] of fieldRows) {
    const cells = LEVELS.map((l) => padL(f[l].total ? `${pct(f[l].corrected, f[l].total)} (${f[l].total})` : "—", 12)).join("");
    console.log(`${pad(field, 16)}${cells}`);
  }

  // ---- batch-approve sizing: how many pending items are "all-High" ----
  // An item is a clean batch-approve candidate when every confidence-stamped
  // field is High (no Medium/Low doubt anywhere).
  const pending = items.filter((it) => it.status === "draft" || it.status === "needs-review");
  let allHigh = 0, hasDoubt = 0, noConf = 0;
  for (const it of pending) {
    const levels = Object.entries(it.confidence || {})
      .filter(([k]) => !NON_AI_FIELDS.has(k)).map(([, v]) => v);
    if (!levels.length) { noConf++; continue; }
    if (levels.every((l) => l === "High")) allHigh++;
    else hasDoubt++;
  }
  console.log("\n=== BATCH-APPROVE SIZING (current pending queue) ===============");
  console.log(`Pending items (draft/needs-review): ${pending.length}`);
  console.log(`  all-High (one-tap approve candidates): ${allHigh}`);
  console.log(`  has a Medium/Low field (needs a look): ${hasDoubt}`);
  console.log(`  no confidence data:                    ${noConf}`);

  console.log("\n=== CAVEATS ====================================================");
  console.log("1. 'Corrected' counts only fields a human ACTUALLY changed. A missed");
  console.log("   error looks 'correct' here, so each rate is a LOWER bound on true");
  console.log("   error. If even this lower bound is high, the signal is bad.");
  console.log("2. Reviewers can hand-edit confidence pills. If they lowered a pill");
  console.log("   while fixing a field, that correction is attributed to the lower");
  console.log("   level — making High look better than it is. Treat High as a");
  console.log("   best-case read; confirm with a fresh manual sample if it's close.");
  console.log("3. Bulk edits also write audit rows, so some 'corrections' may be");
  console.log("   bulk operations, not per-item judgment.");
  console.log("");
}

main();
