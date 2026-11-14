// Documentation: everything the app does, how it was built and checked, and where not to trust it.
// Every number is read from pipeline output files, none is typed in by hand.
import { $, $$, data, fmt, table, barChart, icon } from "./util.js";

const SECTIONS = [
  ["overview", "What On Fire is"], ["use", "Using the app"], ["data", "Data"], ["harm", "Harmonization"],
  ["flares", "Gas flares"], ["events", "Fire events"], ["risk", "AI risk model"], ["truth", "Truth vs Prediction"],
  ["alerts", "Spread and alerts"], ["limits", "Limits"], ["open", "Open data"], ["ai", "Use of AI"],
];

export async function initDocs(meta) {
  const [m, f, fs, ev] = await Promise.all([data("harmonization_metrics.json"), data("flare_metrics.json"),
    data("flare_share.json"), data("events_summary.json")]);
  let r = null, b = null;
  try { [r, b] = await Promise.all([data("risk_metrics.json"), data("backtests.json")]); } catch { /* model not trained */ }
  const FC = r && (r.forecast_assumption === "perfect" || /forecast/i.test(r.model_selection?.chosen || ""));
  const LAB = r?.forecast_label || "assumes a perfect 7-day weather forecast";
  const tag = FC ? `<span class="est fc">${LAB}</span>` : "";
  const band = m.uncertainty_band_p10_p90, sw = m.sensor_switch_check, lf = r?.large_fires;
  const nEvents = Object.values(ev).reduce((s, c) => s + (c.events || 0), 0);
  const sel = r?.model_selection, chosen = sel?.chosen || r?.chosen;
  const sec = (id, ic, title, body) => `<section class="doc-sec" id="doc-${id}"><div class="sec-head"><span class="sec-ic">${icon(ic)}</span><h2>${title}</h2></div>${body}</section>`;

  $("#docs").innerHTML = `
  <nav class="toc" aria-label="Contents"><small>Contents</small>${SECTIONS.map(([id, t], i) => `<a href="#doc-${id}" data-id="${id}"><i>${String(i + 1).padStart(2, "0")}</i>${t}</a>`).join("")}</nav>
  <article>
    <section class="doc-hero" id="doc-overview">
      <span class="tag">Documentation</span>
      <h1>Twenty-five years of satellite fire, in one record</h1>
      <p>On Fire joins NASA's two fire sensors, MODIS (since 2000) and VIIRS (since 2012), into one consistent record for ${m.countries.length} countries in North America, North Africa and the Middle East. That record is what turns a raw satellite hotspot into a flare-free, explainable picture of where fire is unusual, when each place burns, and where it is likely to burn next.</p>
      <div class="facts">
        <div class="fact"><b>${m.headline.before_pct}% → ${m.headline.after_pct}%</b><small>sensor disagreement, held-out years</small></div>
        <div class="fact"><b>${m.countries.length}</b><small>countries, 2000–${meta.last_year}</small></div>
        <div class="fact"><b>${fmt(nEvents)}</b><small>fire events found</small></div>
        <div class="fact"><b>${lf ? lf.all.model_pct_inside_top10 + "% vs " + lf.all.baseline_pct_inside_top10 + "%" : "–"}</b><small>large fires in top-10% risk${FC ? "*" : ""}</small></div>
      </div>
      ${FC ? `<p style="font-size:12.5px;margin-top:12px">* ${LAB}.</p>` : ""}
    </section>

    <div class="card" style="margin-top:14px"><div class="sec-head"><span class="sec-ic">${icon("sensors")}</span><h2>How harmonization powers everything</h2></div>
      <table><thead><tr><th>Feature</th><th style="text-align:left">What the harmonized record gives it</th></tr></thead><tbody>
        <tr><td>Burning calendar (Seasonality)</td><td style="text-align:left">One consistent series from 2000, with no artificial jump at 2012</td></tr>
        <tr><td>"Against normal" colouring</td><td style="text-align:left">A stable baseline for "unusual for this place and month"</td></tr>
        <tr><td>Gas-flare filter</td><td style="text-align:left">Persistence over many years separates flares from fires</td></tr>
        <tr><td>AI risk model</td><td style="text-align:left">A consistent fire-history input; raw counts would mislead it</td></tr>
        <tr><td>Fire severity and alerts</td><td style="text-align:left">Severity against what is normal for the country, flares removed</td></tr>
      </tbody></table></div>

    ${sec("use", "globe", "Using the app", `
      <div class="steps">
        <div class="step"><div><b>Fires</b><span>Fire events on any date from 2012 to ${meta.last_year}, rebuilt from the satellite archive. Pick a date and a window (24h, 3 days, 7 days) at the top. Dot size and colour show size against the country's own record. Click a fire to fly in: hotspots day by day, wind, an estimated spread envelope, people in reach and a draft alert.</span></div></div>
        <div class="step"><div><b>History</b><span>The usual fire places for each month, from 25 years of harmonized records, or one chosen year. Press play to step through the year. Country labels show what share of a year's fire falls in that month.</span></div></div>
        <div class="step"><div><b>AI risk</b><span>The model's chance that each 25 km cell burns in the latest week of the record. Red alert = 75% or more, high = 50% or more. Pulsing markers are the top alerts; click any square for the reasons.</span></div></div>
        <div class="step"><div><b>Truth vs Prediction</b><span>Six past fires replayed: the frozen model's risk map before the fire, against what burned. It plays by itself; drag the line to take over.</span></div></div>
        <div class="step"><div><b>The side panel</b><span>Choose all regions, a region, or click a country. Tabs: <b>Overview</b> (fires on the date), <b>AI risk</b>, <b>Seasonality</b> (the burning calendar, any drawn area, CSV and PNG downloads) and <b>Harmonization</b> (the proof for that country).</span></div></div>
      </div>`)}

    ${sec("data", "layers", "Data", `<ul>
      <li><b>NASA FIRMS active-fire archive:</b> MODIS (Terra and Aqua, Collection 6.1) from November 2000 and VIIRS (Suomi NPP, 375 m) from January 2012, through ${meta.last_year}, for ${m.countries.length} countries.</li>
      <li><b>Quality filter:</b> MODIS detections with confidence of at least 30; VIIRS detections not marked low confidence. Only detections NASA marks as vegetation fires are counted.</li>
      <li><b>Weather</b> for the risk model: NASA POWER (MERRA-2), weekly, on a 1° grid. <b>Wind and air quality</b> for an opened fire: Open-Meteo (ERA5 and Copernicus CAMS).</li>
      <li><b>Maps:</b> NASA GIBS (Blue Marble, VIIRS true colour, Black Marble) and Esri World Imagery. <b>Boundaries:</b> Natural Earth. <b>Villages, towns and cities:</b> GeoNames (500 people or more). <b>Vegetation:</b> NASA MODIS land cover (MCD12Q1, 500 m) via NASA GIBS.</li>
    </ul>`)}

    ${sec("harm", "sensors", "Harmonization", `
      <p>VIIRS pixels are about seven times smaller than MODIS pixels, so the same fire produces many more VIIRS detections, and small fires are seen only by VIIRS. A naive switch from one sensor to the other in 2012 creates a jump that looks like a fire crisis.</p>
      <div class="steps">
        <div class="step"><div><b>Vegetation fires only</b><span>Detections marked as volcanoes, static land sources or offshore are removed.</span></div></div>
        <div class="step"><div><b>Count active cell-days, not pixels</b><span>Both sensors are reduced to the number of distinct ${m.fine_grid_deg}° cells burning on each day.</span></div></div>
        <div class="step"><div><b>Calibrate MODIS to VIIRS on the overlap years</b><span>Per country and season: a power law where MODIS saw fire, plus a small-fire background where MODIS saw nothing. Months before July 2002 use a Terra-only calibration.</span></div></div>
        <div class="step"><div><b>One series</b><span>VIIRS from 2012 onward; calibrated MODIS before that, with a 10th–90th percentile band (${band[0]}× to ${band[1]}×).</span></div></div>
      </div>
      <div class="doc-grid three">
        <div class="tile hot"><div class="t-label">Disagreement</div><div class="t-val ember">${m.headline.before_pct}% → ${m.headline.after_pct}%</div><div class="t-sub">on held-out years ${m.held_out_years.join(", ")}</div></div>
        <div class="tile"><div class="t-label">2012 sensor switch</div><div class="t-val">×${sw.mean_factor_error_naive_switch} → ×${sw.mean_factor_error_harmonized}</div><div class="t-sub">average error, naive vs harmonized</div></div>
        <div class="tile"><div class="t-label">Chosen method</div><div class="t-val sm">${m.chosen_variant}</div><div class="t-sub">${m.variant_selection}</div></div>
      </div>
      <div class="doc-grid">
        <div class="card"><h2>Methods compared on held-out years</h2><div id="dc-abl"></div><div class="note">${m.definition}</div></div>
        <div class="card"><h2>Each country, before and after</h2><div id="dc-cty" style="max-height:420px;overflow:auto"></div></div>
      </div>
      <div class="card"><h2>Independent check at the 2012 sensor switch</h2><p class="desc">${sw.note}</p><div id="dc-sw" style="max-height:380px;overflow:auto"></div></div>`)}

    ${sec("flares", "flare", "Gas flares", `
      <p>Across the oil-producing countries of the region, most satellite "fire" detections are industrial flares. On Fire finds them by behaviour (the same 2 km spot burning month after month), so the detector also works on new data that carries no NASA flag. They are removed before anything is counted, and from the risk model's target.</p>
      <div class="doc-grid">
        <div class="card"><h2>Share of detections that are static sources</h2><div id="dc-fs"></div></div>
        <div class="card"><h2>Detector checked against NASA's flag</h2>
          <dl class="kv"><dt>Rule</dt><dd style="white-space:normal">${f.rule}</dd>
          <dt>Precision, by detections</dt><dd>${(f.detection_weighted.precision * 100).toFixed(1)}%</dd>
          <dt>Recall, by detections</dt><dd>${(f.detection_weighted.recall * 100).toFixed(1)}%</dd>
          <dt>Precision, by location</dt><dd>${(f.cell_level.precision * 100).toFixed(1)}%</dd>
          <dt>Recall, by location</dt><dd>${(f.cell_level.recall * 100).toFixed(1)}%</dd>
          <dt>Scored on</dt><dd>${fmt(f.test_cells)} locations not used for tuning</dd></dl>
          <div class="note">${f.caveat}</div></div>
      </div>`)}

    ${sec("events", "fire", "Fire events", `<ul>
      <li>VIIRS vegetation detections (flares removed) are grouped into events: burning 0.05° cells that touch and are at most two days apart belong to the same fire. ${fmt(nEvents)} events were found across ${Object.keys(ev).length} countries.</li>
      <li><b>Severity</b> is a fire's size (detections) against every fire recorded in the same country: critical = top 1%, large = top 10%, moderate = top 50%. It is relative, not an absolute danger scale.</li>
      <li><b>Area touched</b> is the area of the cells a fire reached: an upper bound, not burned area.</li>
    </ul>`)}

    ${r ? sec("risk", "chip", "AI risk model", `
      ${FC ? `<div class="hero warn" style="margin-top:6px"><div class="hero-ic">${icon("warn")}</div><div class="hero-body"><h3>Read this first</h3><p>The chosen version uses the weather of the week it predicts, as a 7-day forecast would give it. In every backtest that weather is the real one, so its numbers <b>${LAB}</b> and are an upper bound. Fire data from the predicted week is never used.</p></div></div>` : ""}
      <ul>
        <li><b>Question.</b> ${r.question}</li>
        <li><b>Model.</b> Gradient-boosted decision trees (LightGBM), ${r.trees} trees, ${r.features.length} inputs: harmonized fire history since 2000, recent fire in and around the cell, weather, season and location.</li>
        <li><b>Split by time.</b> Trained on ${r.split.train}; tuned on ${r.split.tune}; then frozen and scored on ${r.split.test}: ${fmt(r.test_cell_weeks)} cell-weeks it had never seen.</li>
        ${sel ? `<li><b>How the version was chosen.</b> ${sel.rule} ${sel.disclosure || ""}</li>` : ""}
      </ul>
      <div class="doc-grid three">
        <div class="tile hot"><div class="t-label">Large fires begun in top-10% risk</div><div class="t-val ember">${lf ? lf.all.model_pct_inside_top10 + "%" : "–"}<small>vs ${lf ? lf.all.baseline_pct_inside_top10 + "%" : ""}</small></div><div class="t-sub">${lf ? fmt(lf.all.fires) + " critical fires, 2021–2025" : ""} ${tag}</div></div>
        <div class="tile"><div class="t-label">Precision-recall score</div><div class="t-val">${r.model.pr_auc.toFixed(2)}<small>vs ${r.baseline_climatology.pr_auc.toFixed(2)}</small></div><div class="t-sub">model vs baseline, test years ${tag}</div></div>
        <div class="tile"><div class="t-label">Burning cell-weeks in top 10%</div><div class="t-val">${Math.round(r.model.share_of_fires_in_top10pct * 100)}%<small>vs ${Math.round(r.baseline_climatology.share_of_fires_in_top10pct * 100)}%</small></div><div class="t-sub">test years ${tag}</div></div>
      </div>
      <p class="note">The headline number is the all-large-fires score: every critical fire of 2021–2025, not a chosen few. Baseline = how often the place burned in that week of the year before (2012–2020).</p>
      ${sel?.test_scores ? `<div class="card"><h2>Every version, side by side</h2><div id="dc-ver" style="overflow-x:auto"></div></div>` : ""}
      <div class="doc-grid">
        ${lf ? `<div class="card"><h2>Large fires by region</h2><div id="dc-lf"></div><div class="note">${lf.definition}</div></div>` : ""}
        <div class="card"><h2>What the model relies on</h2><div id="dc-imp"></div></div>
      </div>
      <div class="doc-grid">
        <div class="card"><h2>When the model says X%, how often does it burn?</h2><div id="dc-cal"></div><div class="note">Scored on the test years only. Close columns = well calibrated.</div></div>
        <div class="card"><h2>Score by year</h2><div id="dc-year"></div></div>
      </div>`) : sec("risk", "chip", "AI risk model", `<p>The risk model has not been trained yet.</p>`)}

    ${b ? sec("truth", "split", "Truth vs Prediction", `
      <p>Six fires, each scored once by the frozen model with fire data from before the week it began. Three were fixed before any model was trained (Dixie, Kabylie, Manavgat); three more are chosen by a rule, the largest fire in each region in 2021–2025. All six are reported whatever the result.${FC ? ` Results ${LAB}.` : ""}</p>
      <div class="card"><div id="dc-bt"></div><div class="note">Rank = share of the country's cells rated below the fire's cells. Flagged above 90%, raised above 60%.</div></div>`) : ""}

    ${sec("alerts", "alert", "Spread estimate and alert drafts", `<ul>
      <li><b>Wind</b> for the fire's location and date comes from Open-Meteo's archive (ERA5). The strongest hour of the day is used.</li>
      <li><b>Spread envelope.</b> The fire front is assumed to advance at about 10% of the 10 m wind speed (Cruz &amp; Alexander 2019, a rule of thumb for dry fuels that tends to the high side), inside an ellipse whose length-to-breadth ratio grows with wind (Alexander 1985). Terrain, vegetation, fuel moisture and firefighting are not modelled.</li>
      <li><b>People in reach</b> are residents of villages, towns and cities of 500 or more inside each envelope or radius. Smaller hamlets and people living outside named places are not counted.</li>
      <li><b>What is burning</b> is the MODIS land cover of the year before the fire under each detection (500 m pixels, so small fields and villages can be missed).</li>
      <li><b>Air quality</b> comes from the Copernicus atmosphere service and is only available from August 2022.</li>
      <li><b>Alert drafts</b> are fixed English sentence templates filled with these numbers, exported in the Common Alerting Protocol format with status "Draft". On Fire is decision support for authorities: it drafts and exports, and never sends or broadcasts anything.</li>
    </ul>`)}

    ${sec("limits", "warn", "Limits: read before relying on this", `<ul>
      <li>Harmonized values before 2012 are estimates. For a single country-month the true value typically lies between ${band[0]}× and ${band[1]}× the estimate.</li>
      <li>In places where MODIS saw nothing, the pre-2012 value is the calibrated small-fire background for that cell and season, so low-fire areas can look flat from month to month before 2012.</li>
      <li>Harmonization works on totals per grid cell and month. It cannot recover individual small fires MODIS never saw.</li>
      <li>It is weakest for very small countries and where almost all detections are industrial (see the per-country table above).</li>
      <li>Satellites miss fires under cloud or thick smoke and between overpasses. A count of detections is not a count of fires.</li>
      <li>The flare detector finds persistent sources. By location its recall is only ${(f.cell_level.recall * 100).toFixed(0)}%: small or occasional static sources are missed.</li>
      ${r ? r.limits.map(l => `<li>${l}</li>`).join("") : ""}
      <li>Risk scores and spread zones are model estimates for decision support. This tool does not issue evacuation orders.</li>
    </ul>`)}

    ${sec("open", "download", "Open data", `<p>The harmonized record is free to download and reuse. Units: harmonized = VIIRS-equivalent active cell-days on a ${m.fine_grid_deg}° grid. Source data: NASA FIRMS (public domain).</p>
      <div class="row" style="margin-top:12px">
        <a class="btn primary" href="/api/data/country_month.json" download>${icon("download")}Country × month series</a>
        <a class="btn" href="/api/data/harmonization_metrics.json" download>${icon("download")}Validation results</a>
        <a class="btn" href="/api/data/flares.json" download>${icon("download")}Static heat sources</a>
        ${r ? `<a class="btn" href="/api/data/risk_metrics.json" download>${icon("download")}Risk model scores</a>` : ""}
      </div><p class="note">Any country, region or drawn area also exports its own calendar as CSV or PNG from the Seasonality tab.</p>`)}

    ${sec("ai", "book", "Use of AI", `<p>The code for this project was written with the help of an AI coding assistant, directed and reviewed by the team. The risk model is a gradient-boosted decision tree model (LightGBM) trained on the data described above; it is not a language model. No AI service is called by the running application; alert text is produced from fixed templates filled with computed numbers.</p>`)}
  </article>`;

  table($("#dc-abl"), [{ label: "Method", get: x => x.variant }, { label: "Disagreement", get: x => x.disagreement_pct + "%" },
    { label: "Bias", get: x => x.bias_pct + "%" }, { label: "Correlation", get: x => x.log_corr }], m.ablation, x => x.variant === m.chosen_variant);
  table($("#dc-cty"), [{ label: "Country", get: x => x[0] }, { label: "Before", get: x => x[1].before.disagreement_pct + "%" },
    { label: "After", get: x => x[1].after.disagreement_pct + "%" }, { label: "Bias after", get: x => x[1].after.bias_pct + "%" }],
    Object.entries(m.per_country).sort((a, c) => a[1].after.disagreement_pct - c[1].after.disagreement_pct));
  table($("#dc-sw"), [{ label: "Country", get: x => x[0] }, { label: "MODIS-only reference", get: x => "×" + x[1].modis_only_reference },
    { label: "Harmonized", get: x => "×" + x[1].harmonized }, { label: "Naive switch", get: x => "×" + x[1].naive_sensor_switch }], Object.entries(sw.by_country));
  barChart($("#dc-fs"), fs.filter(x => x.detections > 5000).slice(0, 12).map(x => ({ label: x.country, value: x.nasa_static_pct, cls: "cyan" })), { horizontal: true, unit: "%" });
  if (r) {
    if (sel?.test_scores) $("#dc-ver").innerHTML = `<table><thead><tr><th>Version</th><th>Score 2019–2020<br><small>used to choose</small></th><th>Score 2021–2025<br><small>never used to choose</small></th><th>Burning cell-weeks in top 10%</th><th>Large fires in top 10%</th></tr></thead><tbody>
      ${Object.entries(sel.test_scores).map(([n, t]) => `<tr class="${n === chosen ? "chosen" : ""}"><td>${n}${n === chosen ? " — chosen" : ""}${/forecast/i.test(n) ? ` <span class="est fc">${LAB}</span>` : ""}</td>
        <td class="mono">${sel.tune_years_pr_auc?.[n]?.toFixed(3) ?? "–"}</td><td class="mono">${t.pr_auc.toFixed(3)}</td><td class="mono">${(t.share_of_fires_in_top10pct * 100).toFixed(1)}%</td>
        <td class="mono">${lf?.by_version?.[n]?.all ? lf.by_version[n].all.model_pct_inside_top10 + "%" : "–"}</td></tr>`).join("")}
      <tr><td>Baseline (how often the place burned that week before)</td><td class="mono">–</td><td class="mono">${r.baseline_climatology.pr_auc.toFixed(3)}</td><td class="mono">${(r.baseline_climatology.share_of_fires_in_top10pct * 100).toFixed(1)}%</td><td class="mono">${lf ? lf.all.baseline_pct_inside_top10 + "%" : "–"}</td></tr></tbody></table>`;
    if (lf) table($("#dc-lf"), [{ label: "Region", get: x => x[0] }, { label: "Fires", get: x => fmt(x[1].fires) },
      { label: "Model", get: x => x[1].model_pct_inside_top10 + "%" }, { label: "Baseline", get: x => x[1].baseline_pct_inside_top10 + "%" },
      { label: "Median rank", get: x => x[1].model_median_rank_pct + "%" }], [["All regions", lf.all], ...Object.entries(lf.by_region)]);
    barChart($("#dc-imp"), Object.entries(r.importance_pct).map(([k, v]) => ({ label: k, value: v })), { horizontal: true, unit: "%" });
    const pc = v => v == null ? "–" : (Math.round(v * 1000) / 10) + "%";
    table($("#dc-cal"), [{ label: "Model said", get: x => x.bin }, { label: "Average prediction", get: x => pc(x.predicted) },
      { label: "Actually burned", get: x => pc(x.observed) }, { label: "Cell-weeks", get: x => fmt(x.cell_weeks) }], r.calibration);
    table($("#dc-year"), [{ label: "Year", get: x => x[0] }, { label: FC ? "Chosen model*" : "Model", get: x => x[1].model_pr_auc.toFixed(3) },
      ...(Object.values(r.by_year)[0]?.no_forecast_pr_auc != null ? [{ label: "No forecast", get: x => x[1].no_forecast_pr_auc.toFixed(3) }] : []),
      { label: "Baseline", get: x => x[1].baseline_pr_auc.toFixed(3) }], Object.entries(r.by_year));
    if (FC) $("#dc-year").insertAdjacentHTML("beforeend", `<div class="note">* ${LAB}.</div>`);
  }
  if (b) table($("#dc-bt"), [{ label: "Fire", get: x => x[0] }, { label: "Began", get: x => x[1].fire_start },
    { label: "Chosen", get: x => !x[1].group || x[1].group.startsWith("Fixed") ? "fixed in advance" : "by rule" },
    { label: "Rank, model", get: x => x[1].model.risk_percentile_in_country + "%" }, { label: "Rank, baseline", get: x => x[1].baseline.risk_percentile_in_country + "%" },
    { label: "Verdict", get: x => { const p = x[1].model.risk_percentile_in_country; return p >= 90 ? "flagged" : p >= 60 ? "raised" : "not anticipated"; } }], Object.entries(b));

  // table of contents follows the scroll
  const links = $$(".toc a"), scroller = $("#view-docs");
  links.forEach(a => a.addEventListener("click", e => { e.preventDefault(); $(a.getAttribute("href")).scrollIntoView({ behavior: "smooth", block: "start" }); }));
  const io = new IntersectionObserver(es => { for (const e of es) if (e.isIntersecting) {
    const id = e.target.id.replace("doc-", ""); links.forEach(a => a.classList.toggle("on", a.dataset.id === id)); } },
    { root: scroller, rootMargin: "-10% 0px -75% 0px" });
  $$(".doc-sec, .doc-hero").forEach(s => io.observe(s));
}
