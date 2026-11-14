// On Fire's Python-served pages: Truth vs Prediction and Documentation.
// The map pages (Live fires / Forecast / History / AI risk) are the web app in ../web, which
// shows this page inside its "Truth vs Prediction" tab via ?embed=truth.
import { $, $$, getJSON } from "./util.js";
import { loadStep, loadDone, loadFail } from "./logo.js";
import { initTruth, truthShown } from "./truth.js";
import { initDocs } from "./docs.js";

const VIEWS = ["truth", "docs"];
const EMBED = new URLSearchParams(location.search).get("embed");
const started = {};
let meta;

async function show(view) {
  $$("#nav button[data-view]").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  $$(".view").forEach(v => v.classList.toggle("active", v.id === `view-${view}`));
  truthShown(view === "truth");
  if (history.replaceState) history.replaceState(null, "", location.search + "#" + view);
  try {
    if (view === "truth" && !started.truth) { started.truth = true; await initTruth(); }
    else if (view === "docs" && !started.docs) { started.docs = true; await initDocs(meta); }
  } catch (e) { console.error(e); started[view] = false; }
}

function clock() {
  const t = () => { $("#clock").textContent = "UTC " + new Date().toISOString().slice(11, 19); };
  t(); setInterval(t, 1000);
}

async function start() {
  if (EMBED) document.body.classList.add("embed");
  clock();
  loadStep("Reading the record index", 12);
  meta = await getJSON("/api/meta");
  $("#data-status").textContent = `FIRMS archive · ${meta.first_year}–${meta.last_year}`;
  $$("#nav button[data-view]").forEach(b => b.addEventListener("click", () => show(b.dataset.view)));
  $(".brand").addEventListener("click", e => { e.preventDefault(); show("truth"); });
  $("#cvd").addEventListener("change", e => document.body.classList.toggle("cvd", e.target.checked));
  document.addEventListener("want-view", e => VIEWS.includes(e.detail) && show(e.detail));
  addEventListener("keydown", e => {
    if (e.target.closest("input, select, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = { 1: "truth", 2: "docs" }[e.key];
    if (k && !EMBED) show(k);
  });
  const want = EMBED || location.hash.slice(1);
  await show(VIEWS.includes(want) ? want : "truth");
  loadDone();
}
start().catch(e => { console.error(e); loadFail(`Could not start: ${e.message}. Is the server running?`); });
